import { describe, expect, it, vi } from "vitest";
import type { RefreshModelsContext } from "../src/models.ts";
import { InMemoryModelsStore, type ModelsStoreEntry } from "../src/models-store.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";
import type { Model } from "../src/types.ts";

const newModel: Model<"openai-codex-responses"> = {
	id: "gpt-next-fixture",
	name: "Next fixture",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 272_000,
	maxTokens: 128_000,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
};
const nativeModel = (slug = newModel.id) => ({
	slug,
	display_name: "Native next fixture",
	visibility: "list",
	context_window: 272_000,
	max_context_window: 872_000,
	input_modalities: ["text", "image"],
	supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }, { effort: "ultra" }],
});

function fixture({ authMode = "oauth", models = [nativeModel()], metadata = [newModel] } = {}) {
	const store = new InMemoryModelsStore();
	let snapshot: ModelsStoreEntry | undefined;
	const writeToStore = store.write.bind(store);
	store.write = async (providerId, entry) => {
		snapshot = entry;
		await writeToStore(providerId, entry);
	};
	const metadataFetch = vi.fn<typeof fetch>(async (url) =>
		String(url).endsWith("/latest")
			? Response.json({ version: "0.999.1" })
			: Response.json(Object.fromEntries(metadata.map((model) => [model.id, model]))),
	);
	const catalogFetch = vi.fn<typeof fetch>(async () => Response.json({ models }));
	const provider = openaiCodexProvider({
		catalogFetch,
		metadataFetch,
		catalogAuthMode: authMode as "oauth" | "transport",
	});
	const context: RefreshModelsContext = {
		credential: {
			type: "oauth",
			access: "private-access",
			refresh: "private-refresh",
			accountId: "account-fixture",
			expires: Date.now() + 60_000,
		},
		allowNetwork: true,
		signal: new AbortController().signal,
		get stored() {
			return snapshot;
		},
		publish: async (publication) => {
			if (publication.persist) await store.write(provider.id, publication.persist);
			publication.update?.();
			return true;
		},
	};
	return { provider, context, store, metadataFetch, catalogFetch };
}

describe("native Codex model discovery", () => {
	it("adds a previously unknown model with separate default/maximum context and preserves existing models", async () => {
		const { provider, context } = fixture();
		const existingIds = provider.getModels().map((model) => model.id);
		await provider.refreshModels?.(context);
		expect(provider.getModels().map((model) => model.id)).toEqual([...existingIds, newModel.id]);
		expect(provider.getModels().find((model) => model.id === newModel.id)).toMatchObject({
			name: "Native next fixture",
			contextWindow: 272_000,
			maxContextWindow: 872_000,
			maxTokens: 128_000,
			cost: newModel.cost,
			thinkingLevelMap: { low: "low", high: "high", max: "max" },
		});
		expect(provider.compactOpenAICodexResponses).toBeTypeOf("function");
	});

	it("uses current upstream version metadata, without sending OAuth credentials to public metadata services", async () => {
		const { provider, context, metadataFetch, catalogFetch } = fixture();
		await provider.refreshModels?.(context);
		expect(catalogFetch.mock.calls[0]?.[0]).toBe(
			"https://chatgpt.com/backend-api/codex/models?client_version=0.999.1",
		);
		const nativeHeaders = new Headers(catalogFetch.mock.calls[0]?.[1]?.headers);
		expect(nativeHeaders.get("authorization")).toBe("Bearer private-access");
		expect(nativeHeaders.get("chatgpt-account-id")).toBe("account-fixture");
		for (const [url, init] of metadataFetch.mock.calls) {
			expect(["registry.npmjs.org", "pi.dev"]).toContain(new URL(String(url)).hostname);
			expect(new Headers(init?.headers).has("authorization")).toBe(false);
			expect(new Headers(init?.headers).has("chatgpt-account-id")).toBe(false);
		}
	});

	it("allows the host relay to own authentication without a local token", async () => {
		const { provider, context, catalogFetch } = fixture({ authMode: "transport" });
		context.credential = { type: "api_key" };
		await provider.refreshModels?.(context);
		expect(new Headers(catalogFetch.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
		expect(provider.getModels().some((model) => model.id === newModel.id)).toBe(true);
	});

	it("does not expose hidden new models or import transport configuration and unsupported reasoning modes", async () => {
		const { provider, context } = fixture({
			models: [nativeModel(), { ...nativeModel("hidden-fixture"), visibility: "hide" }],
			metadata: [
				{
					...newModel,
					baseUrl: "https://untrusted.test",
					headers: { Authorization: "catalog-value" },
					thinkingLevelMap: { xhigh: "ultra" },
				},
			],
		});
		await provider.refreshModels?.(context);
		const added = provider.getModels().find((model) => model.id === newModel.id);
		expect(added?.baseUrl).toBe("https://chatgpt.com/backend-api");
		expect(added?.headers).toBeUndefined();
		expect(added?.thinkingLevelMap?.xhigh).toBeNull();
		expect(Object.values(added?.thinkingLevelMap ?? {})).not.toContain("ultra");
		expect(provider.getModels().some((model) => model.id === "hidden-fixture")).toBe(false);
	});

	it("retains discovered models across offline restart and subsequent omission from the native list", async () => {
		const { provider, context, catalogFetch } = fixture();
		await provider.refreshModels?.(context);
		catalogFetch.mockResolvedValue(Response.json({ models: [] }));
		await provider.refreshModels?.({ ...context, force: true });
		expect(provider.getModels().some((model) => model.id === newModel.id)).toBe(true);
		const restarted = openaiCodexProvider({
			catalogFetch: async () => {
				throw new Error("Offline native network request");
			},
			metadataFetch: async () => {
				throw new Error("Offline public network request");
			},
		});
		await restarted.refreshModels?.({ ...context, allowNetwork: false });
		expect(restarted.getModels().find((model) => model.id === newModel.id)).toMatchObject({
			maxContextWindow: 872_000,
		});
	});

	it("respects freshness, allows forced refresh, and does not mistake an old pi.dev cache for a native check", async () => {
		const { provider, context, store, catalogFetch } = fixture();
		await store.write(provider.id, { models: [newModel], checkedAt: Date.now() });
		await provider.refreshModels?.(context);
		expect(provider.getModels().find((model) => model.id === newModel.id)?.maxContextWindow).toBe(872_000);
		catalogFetch.mockResolvedValue(Response.json({ models: [{ ...nativeModel(), max_context_window: 1_000_000 }] }));
		await provider.refreshModels?.(context);
		expect(provider.getModels().find((model) => model.id === newModel.id)?.maxContextWindow).toBe(872_000);
		await provider.refreshModels?.({ ...context, force: true });
		expect(provider.getModels().find((model) => model.id === newModel.id)?.maxContextWindow).toBe(1_000_000);
	});

	it("does not resurrect an obsolete public-feed context override when loading a pre-native cache", async () => {
		const { provider, context, store } = fixture();
		const astra = provider.getModels().find((model) => model.id === "gpt-6-astra")!;
		await store.write(provider.id, {
			models: [{ ...astra, contextWindow: 1_000_000 }, newModel],
			checkedAt: Date.now(),
			lastModified: 0,
		});
		await provider.refreshModels?.({ ...context, allowNetwork: false });
		expect(provider.getModels().find((model) => model.id === astra.id)?.contextWindow).toBe(272_000);
		expect(provider.getModels().some((model) => model.id === newModel.id)).toBe(true);
	});

	it("reports upstream failure without discarding a usable catalog or exposing response bodies", async () => {
		const { provider, context, catalogFetch } = fixture();
		await provider.refreshModels?.(context);
		catalogFetch.mockResolvedValue(new Response("private-upstream-body", { status: 503 }));
		await expect(provider.refreshModels?.({ ...context, force: true })).rejects.toThrow(
			"Codex model discovery failed (503).",
		);
		expect(provider.getModels().some((model) => model.id === newModel.id)).toBe(true);
	});

	it("does not invent pricing or output limits for a new model missing enrichment metadata", async () => {
		const { provider, context } = fixture({ metadata: [] });
		await expect(provider.refreshModels?.(context)).rejects.toThrow(
			"await output/pricing metadata: gpt-next-fixture",
		);
		expect(provider.getModels().some((model) => model.id === newModel.id)).toBe(false);
	});

	it("rejects invalid context metadata without publishing a partial invalid replacement", async () => {
		const { provider, context } = fixture({ models: [{ ...nativeModel(), max_context_window: 100 }] });
		await expect(provider.refreshModels?.(context)).rejects.toThrow("inconsistent context limits");
		expect(provider.getModels().some((model) => model.id === newModel.id)).toBe(false);
	});
});
