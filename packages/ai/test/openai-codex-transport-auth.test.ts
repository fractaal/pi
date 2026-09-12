import { zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	compactOpenAICodexResponses,
	getOpenAICodexResponseFailure,
	stream,
	streamSimple,
} from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};
const context: Context = {
	messages: [{ role: "user", content: "Synthetic context", timestamp: 1 }],
};

function sse(items: unknown[] = []): Response {
	const events = [
		...items.map((item) => ({ type: "response.output_item.done", item })),
		{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 12, output_tokens: 2 } } },
	];
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected global network request");
		}),
	);
	vi.stubGlobal(
		"WebSocket",
		vi.fn(() => {
			throw new Error("Unexpected WebSocket request");
		}),
	);
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	expect(globalThis.WebSocket).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
});

describe("Codex caller-authenticated HTTP transport", () => {
	it.each([stream, streamSimple])("uses native processing without a provider token", async (send) => {
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBeNull();
			expect(headers.get("chatgpt-account-id")).toBeNull();
			expect(headers.get("accept")).toBe("text/event-stream");
			return sse();
		});
		const result = await send(model, context, { authMode: "transport", fetch, transport: "websocket" }).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(12);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("never copies a token or account header into the authenticated transport", async () => {
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBeNull();
			expect(headers.get("chatgpt-account-id")).toBeNull();
			return sse();
		});
		const result = await streamSimple(
			{ ...model, headers: { Authorization: "Bearer inherited-model-token", "chatgpt-account-id": "old-account" } },
			context,
			{
				authMode: "transport",
				apiKey: "ignored-not-a-jwt",
				headers: { authorization: "Bearer inherited-option-token" },
				fetch,
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("compacts and replays opaque checkpoints through the same token-free transport", async () => {
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const bytes = init?.body;
			const text = bytes instanceof Uint8Array ? zstdDecompressSync(bytes).toString("utf8") : String(bytes);
			const body = JSON.parse(text) as { input: unknown[] };
			expect(body.input[0]).toEqual({ type: "compaction", encrypted_content: "previous-checkpoint" });
			expect(body.input.at(-1)).toEqual({ type: "compaction_trigger" });
			expect(new Headers(init?.headers).has("authorization")).toBe(false);
			return sse([{ type: "compaction", encrypted_content: "next-checkpoint" }]);
		});
		const result = await compactOpenAICodexResponses(model, context, {
			authMode: "transport",
			fetch,
			nativeCompactionCheckpoint: {
				provider: "openai-codex",
				modelId: model.id,
				item: { type: "compaction", encrypted_content: "previous-checkpoint" },
			},
		});
		expect(result.item.encrypted_content).toBe("next-checkpoint");
		expect(result.tokensBefore).toBe(12);
	});

	it("requires an explicit custom fetch instead of falling through to global transports", async () => {
		for (const fetch of [undefined, globalThis.fetch]) {
			const result = await stream(model, context, { authMode: "transport", fetch }).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("requires a custom fetch");
		}
	});

	it("retains default direct-token authentication requirements", async () => {
		const fetch = vi.fn(async () => sse());
		const result = await stream(model, context, { fetch, transport: "sse" }).result();
		expect(result.errorMessage).toContain("No API key");
		expect(() => streamSimple(model, context, { fetch })).toThrow("No API key");
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each(["usage_limit_reached", "rate_limit_exceeded"])("preserves typed %s failures", async (code) => {
		const fetch = async () => Response.json({ error: { code, message: "Request rejected" } }, { status: 429 });
		const result = await streamSimple(model, context, { authMode: "transport", fetch }).result();
		expect(getOpenAICodexResponseFailure(result)).toEqual({ code, status: 429 });
	});
});
