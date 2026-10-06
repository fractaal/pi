import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type DeferredCancelOptions,
	type DeferredFetchOptions,
	InMemoryModelsStore,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import type { OpenAICodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "extension-oauth",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("extension provider model lifecycle", () => {
	it("registers native pi-ai providers with their auth implementation", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const nativeModel = {
			...model("native"),
			provider: "extension-native",
			baseUrl: "https://fallback.test/v1",
		};
		const provider: Provider = {
			id: "extension-native",
			name: "Extension Native",
			auth: {
				apiKey: {
					name: "Native setup",
					login: async (interaction) => ({
						type: "api_key",
						key: await interaction.prompt({ type: "secret", message: "API key" }),
					}),
					check: async ({ credential }) =>
						credential?.key ? { type: "api_key", source: "stored native key" } : undefined,
					resolve: async ({ credential }) =>
						credential?.key
							? {
									auth: { apiKey: credential.key, baseUrl: "https://resolved.test/v1" },
									source: "stored native key",
								}
							: undefined,
				},
			},
			getModels: () => [nativeModel],
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};

		runtime.registerNativeProvider(provider);
		const registry = new ModelRegistry(runtime);
		expect(registry.getProvider("extension-native")).toBe(provider);
		expect(registry.getRegisteredNativeProvider("extension-native")).toBe(provider);
		expect(registry.getRegisteredProviderIds()).toContain("extension-native");
		expect(registry.find("extension-native", "native")).toBeDefined();

		await runtime.login("extension-native", "api_key", {
			prompt: async () => "secret",
			notify: () => {},
		});
		expect(await registry.getProviderAuth("extension-native")).toMatchObject({
			auth: { apiKey: "secret", baseUrl: "https://resolved.test/v1" },
		});

		registry.unregisterProvider("extension-native");
		expect(registry.getProvider("extension-native")).toBeUndefined();
	});

	// Regression for #9962: initial model selection reads the snapshot before the async refresh finishes.
	it("marks a native provider with a stored credential as configured when it registers", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				"extension-native": {
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 3_600_000,
				},
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const nativeModel = { ...model("native"), provider: "extension-native" };
		const unused = () => {
			throw new Error("unused");
		};
		const provider: Provider = {
			id: "extension-native",
			name: "Extension Native",
			auth: {
				oauth: {
					name: "Native OAuth",
					login: unused,
					refresh: async (credential) => credential,
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
			getModels: () => [nativeModel],
			stream: unused,
			streamSimple: unused,
		};

		runtime.registerNativeProvider(provider);

		expect(runtime.hasConfiguredAuth("extension-native")).toBe(true);
		expect(runtime.isUsingOAuth("extension-native")).toBe(true);
		expect(runtime.getAvailableSnapshot().map((m) => `${m.provider}/${m.id}`)).toContain("extension-native/native");
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.hasConfiguredAuth("extension-native")).toBe(true);
	});

	it("preserves native deferred methods through provider overlays", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-native-provider-deferred-"));
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"extension-native-deferred": { baseUrl: "https://overlay.test/v1" },
				},
			}),
		);
		try {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsStore: new InMemoryModelsStore(),
				modelsPath,
				allowModelNetwork: false,
			});
			const nativeModel = {
				...model("native-deferred"),
				provider: "extension-native-deferred",
				baseUrl: "https://native.test/v1",
			};
			let fetchedBaseUrl: string | undefined;
			let fetchedOptions: DeferredFetchOptions | undefined;
			let cancelledId: string | undefined;
			let cancelledOptions: DeferredCancelOptions | undefined;
			const provider: Provider = {
				id: "extension-native-deferred",
				name: "Extension Native Deferred",
				auth: {
					apiKey: {
						name: "Native key",
						resolve: async () => ({ auth: { apiKey: "key" }, source: "native" }),
					},
				},
				getModels: () => [nativeModel],
				stream: () => {
					throw new Error("unused");
				},
				streamSimple: () => {
					throw new Error("unused");
				},
				fetchDeferred: (requestModel, _handle, options) => {
					fetchedBaseUrl = requestModel.baseUrl;
					fetchedOptions = options;
					const message = {
						role: "assistant" as const,
						content: [],
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop" as const,
						timestamp: 0,
					};
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
					return stream;
				},
				cancelDeferred: async (_requestModel, handle, options) => {
					cancelledId = handle.id;
					cancelledOptions = options;
				},
			};

			runtime.registerNativeProvider(provider);
			const composedModel = runtime.getModel(provider.id, nativeModel.id);
			expect(composedModel).toBeDefined();

			await runtime.fetchDeferred(
				composedModel!,
				{
					provider: provider.id,
					modelId: nativeModel.id,
					api: nativeModel.api,
					id: "fetch-id",
				},
				{
					wait: 25,
					headers: { "X-Fetch": "fetch" },
					transformHeaders: (headers) => ({ ...headers, "X-Transformed": "fetch" }),
				},
			);
			await runtime.cancelDeferred(
				composedModel!,
				{
					provider: provider.id,
					modelId: nativeModel.id,
					api: nativeModel.api,
					id: "cancel-id",
				},
				{
					timeoutMs: 100,
					transformHeaders: (headers) => ({ ...headers, "X-Transformed": "cancel" }),
				},
			);

			expect(fetchedBaseUrl).toBe("https://overlay.test/v1");
			expect(fetchedOptions).toMatchObject({
				apiKey: "key",
				wait: 25,
				headers: { "X-Fetch": "fetch", "X-Transformed": "fetch" },
			});
			expect(cancelledId).toBe("cancel-id");
			expect(cancelledOptions).toMatchObject({
				apiKey: "key",
				timeoutMs: 100,
				headers: { "X-Transformed": "cancel" },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("delegates native compaction to a registered OpenAI Codex provider", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const nativeModel: Model<"openai-codex-responses"> = {
			id: "gpt-native",
			name: "GPT Native",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://example.test",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const compactOpenAICodexResponses = vi.fn(async () => ({
			item: { type: "compaction" as const, encrypted_content: "opaque" },
			tokensBefore: 12,
			usage: {
				input: 12,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 13,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		}));
		const provider: OpenAICodexProvider = {
			id: "openai-codex",
			name: "Wrapped Codex",
			auth: {
				apiKey: {
					name: "Codex key",
					resolve: async ({ credential }) =>
						credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
				},
			},
			getModels: () => [nativeModel],
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
			compactOpenAICodexResponses,
		};

		runtime.registerNativeProvider(provider);
		await runtime.setRuntimeApiKey("openai-codex", "synthetic-key");

		await expect(
			runtime.compactOpenAICodexResponses(nativeModel, { systemPrompt: "", messages: [] }),
		).resolves.toMatchObject({ item: { encrypted_content: "opaque" } });
		expect(compactOpenAICodexResponses).toHaveBeenCalledWith(
			nativeModel,
			{ systemPrompt: "", messages: [] },
			expect.objectContaining({ apiKey: "synthetic-key" }),
		);
	});

	it("preserves built-in native compaction for older registered providers without the capability", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const nativeModel: Model<"openai-codex-responses"> = {
			id: "gpt-native",
			name: "GPT Native",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://example.test",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const provider: Provider<"openai-codex-responses"> = {
			id: "openai-codex",
			name: "Older Wrapped Codex",
			auth: {
				apiKey: {
					name: "Codex key",
					resolve: async ({ credential }) =>
						credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
				},
			},
			getModels: () => [nativeModel],
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		).toString("base64");
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						`${[
							`data: ${JSON.stringify({
								type: "response.output_item.done",
								item: { type: "compaction", encrypted_content: "opaque" },
							})}`,
							`data: ${JSON.stringify({
								type: "response.completed",
								response: {
									status: "completed",
									usage: { input_tokens: 12, output_tokens: 1, total_tokens: 13 },
								},
							})}`,
						].join("\n\n")}\n\n`,
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			),
		);

		runtime.registerNativeProvider(provider);
		await runtime.setRuntimeApiKey("openai-codex", `aaa.${tokenPayload}.bbb`);

		await expect(
			runtime.compactOpenAICodexResponses(nativeModel, { systemPrompt: "", messages: [] }),
		).resolves.toMatchObject({ item: { encrypted_content: "opaque" } });
	});

	it("applies models.json overrides above native providers", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-native-provider-"));
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"extension-native": {
						modelOverrides: {
							native: { contextWindow: 4242 },
						},
					},
				},
			}),
		);
		try {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsStore: new InMemoryModelsStore(),
				modelsPath,
				allowModelNetwork: false,
			});
			const nativeModel = {
				...model("native"),
				provider: "extension-native",
				baseUrl: "https://native.test/v1",
			};
			runtime.registerNativeProvider({
				id: "extension-native",
				name: "Extension Native",
				auth: {
					apiKey: {
						name: "Native key",
						resolve: async () => ({ auth: { apiKey: "key" }, source: "native" }),
					},
				},
				getModels: () => [nativeModel],
				stream: () => {
					throw new Error("unused");
				},
				streamSimple: () => {
					throw new Error("unused");
				},
			});

			expect(runtime.getModel("extension-native", "native")?.contextWindow).toBe(4242);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("publishes refreshModels results without forcing ModelsStore persistence", async () => {
		const modelsStore = new InMemoryModelsStore();
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore,
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerProvider("extension-dynamic", {
			baseUrl: "http://localhost:8080/v1",
			apiKey: "local",
			api: "openai-completions",
			refreshModels: async () => [
				{
					...model("live"),
					provider: "extension-dynamic",
					baseUrl: "http://localhost:8080/v1",
				},
			],
		});

		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel("extension-dynamic", "live")).toBeDefined();
		expect(await modelsStore.read("extension-dynamic")).toBeUndefined();
	});

	it("applies legacy OAuth modifyModels after async credential initialization", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				"extension-oauth": {
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60_000,
				},
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerProvider("extension-oauth", {
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			models: [model("base")],
			oauth: {
				name: "Extension OAuth",
				login: async () => {
					throw new Error("not used");
				},
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
				modifyModels: (models, credential) =>
					credential.access === "access" ? [...models, model("credential-model")] : models,
			},
		});

		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel("extension-oauth", "base")).toBeDefined();
		expect(runtime.getModel("extension-oauth", "credential-model")).toBeDefined();

		await runtime.logout("extension-oauth");
		expect(runtime.getModel("extension-oauth", "credential-model")).toBeUndefined();
	});
});
