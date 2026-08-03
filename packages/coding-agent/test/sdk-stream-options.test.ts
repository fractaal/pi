import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ModelsSimpleStreamOptions,
	type ProviderHeaders,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { OpenAICodexSimpleStreamOptions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { InlineExtension } from "../src/core/extensions/index.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

describe("createAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-stream-options-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(api: Api): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			headers: { "x-model": "model" },
		};
	}

	function createDoneStream(api: Api) {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.end(message);
		return stream;
	}

	async function captureStreamOptions(
		api: Api,
		settings: Partial<Settings>,
		requestOptions: SimpleStreamOptions = {},
		extensionFactory?: InlineExtension,
	): Promise<SimpleStreamOptions | undefined> {
		const model = createModel(api);
		const settingsManager = SettingsManager.inMemory(settings);
		const resourceLoader = extensionFactory
			? createTestResourceLoader({ extensionsResult: await createTestExtensionsResult([extensionFactory], cwd) })
			: undefined;

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api,
			headers: { "x-provider": "provider" },
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream(api);
			},
		});

		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		try {
			const stream = await session.agent.streamFunction(model, { messages: [] }, requestOptions);
			await stream.result();
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	it("forwards httpIdleTimeoutMs as timeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("defaults timeoutMs from httpIdleTimeoutMs for all providers", async () => {
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("lets request timeoutMs override httpIdleTimeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ httpIdleTimeoutMs: 1234 },
			{ timeoutMs: 0 },
		);

		expect(options?.timeoutMs).toBe(0);
	});

	it("forwards websocketConnectTimeoutMs from settings", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { websocketConnectTimeoutMs: 1234 });

		expect(options?.websocketConnectTimeoutMs).toBe(1234);
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		expect(options?.websocketConnectTimeoutMs).toBe(0);
	});

	it("forwards provider retry settings", async () => {
		const options = await captureStreamOptions("openai-completions", {
			retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } },
		});

		expect(options?.maxRetries).toBe(2);
		expect(options?.maxRetryDelayMs).toBe(3000);
	});

	it("runs before_provider_headers on assembled headers without forwarding the transform", async () => {
		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{ headers: { "x-explicit": "explicit" } },
			(pi) => {
				pi.on("before_provider_headers", (event) => {
					event.headers["x-hook"] = [
						event.headers["x-provider"],
						event.headers["x-model"],
						event.headers["x-explicit"],
					].join(":");
				});
			},
		);

		expect(options?.headers).toMatchObject({
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-hook": "provider:model:explicit",
		});
		expect(options).not.toHaveProperty("transformHeaders");
	});

	it("shares request settings with native compaction and replays checkpoints only through Codex", async () => {
		vi.stubEnv("PI_TELEMETRY", "1");
		const model = {
			...createModel("openai-codex-responses"),
			provider: "openai-codex",
			baseUrl: "https://openrouter.ai/api/v1",
			contextWindow: 200,
		};
		const settingsManager = SettingsManager.inMemory({
			httpIdleTimeoutMs: 1234,
			retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } },
			compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
		});
		const resourceLoader = createTestResourceLoader({
			extensionsResult: await createTestExtensionsResult(
				[
					(pi) => {
						pi.on("before_provider_headers", (event) => {
							event.headers["x-hook"] = `${event.headers["HTTP-Referer"]}:${event.headers["x-provider"]}`;
						});
					},
				],
				cwd,
			),
		});

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let capturedReplayOptions: OpenAICodexSimpleStreamOptions | undefined;
		const providerStream = vi.fn(
			(_model: Model<any>, _context: { messages: unknown[] }, providerOptions?: OpenAICodexSimpleStreamOptions) => {
				capturedReplayOptions = providerOptions;
				return createDoneStream(model.api);
			},
		);
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			apiKey: "test-api-key",
			headers: { "x-provider": "provider" },
			streamSimple: providerStream,
		});
		const modelRuntime = getModelRuntime(modelRegistry);
		let capturedOptions: ModelsSimpleStreamOptions | undefined;
		let transformedHeaders: ProviderHeaders | undefined;
		modelRuntime.compactOpenAICodexResponses = async (_model, _context, requestOptions) => {
			capturedOptions = requestOptions;
			transformedHeaders = await requestOptions?.transformHeaders?.({ "x-provider": "provider" });
			return {
				item: { type: "compaction", encrypted_content: "opaque" },
				tokensBefore: 100,
				usage: {
					input: 100,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 101,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
		};

		const sessionManager = SessionManager.inMemory(cwd, { compactionMode: "openai-native" });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		try {
			for (let turn = 0; turn < 2; turn++) {
				sessionManager.appendMessage({
					role: "user",
					content: `synthetic context ${turn} ${"x".repeat(80)}`,
					timestamp: Date.now(),
				});
				sessionManager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 80,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 100,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
			}
			session.agent.state.messages = sessionManager.buildSessionContext().messages;

			await session.compact();
			expect(sessionManager.getBranch().at(-1)).toMatchObject({ type: "openai_native_compaction" });
			const continuation = await session.agent.streamFunction(model, { messages: [] });
			const continuationResult = await continuation.result();
			expect(continuationResult.stopReason, continuationResult.errorMessage).toBe("stop");

			expect(capturedOptions).toMatchObject({ timeoutMs: 1234, maxRetries: 2, maxRetryDelayMs: 3000 });
			expect(capturedReplayOptions).toMatchObject({
				nativeCompactionCheckpoint: {
					provider: "openai-codex",
					modelId: "capture-model",
					item: { type: "compaction", encrypted_content: "opaque" },
				},
			});
			expect(providerStream).toHaveBeenCalledTimes(1);
			expect(() => session.agent.streamFunction({ ...model, api: "openai-completions" }, { messages: [] })).toThrow(
				/checkpoint requires openai-codex\/capture-model/,
			);
			expect(providerStream).toHaveBeenCalledTimes(1);
			expect(transformedHeaders).toMatchObject({
				"x-provider": "provider",
				"HTTP-Referer": "https://pi.dev",
				"X-OpenRouter-Title": "pi",
				"x-hook": "https://pi.dev:provider",
			});
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});
});
