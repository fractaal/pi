import { afterEach, describe, expect, it, vi } from "vitest";
import {
	compactOpenAICodexResponses,
	getOpenAICodexResponseFailure,
	stream,
} from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 32000,
};
const apiKey = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.test`;
const context = { messages: [] };
const message = "The usage limit has been reached";

function eventFetch(event: Record<string, unknown>) {
	return vi.fn(
		async () =>
			new Response(`data: ${JSON.stringify(event)}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			}),
	);
}

afterEach(() => vi.unstubAllGlobals());

describe("Codex structured error types", () => {
	it.each(["error", "response.failed"])("preserves quota type from %s without retaining the payload", async (type) => {
		const error = { type: "usage_limit_reached", message, private_detail: "must-not-persist" };
		const event = type === "error" ? { type, error } : { type, response: { error } };
		const result = await stream(model, context, { apiKey, transport: "sse", fetch: eventFetch(event) }).result();
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([]);
		expect(result.errorMessage).toContain(message);
		expect(getOpenAICodexResponseFailure(result)?.code).toBe("usage_limit_reached");
		expect(JSON.stringify(result.diagnostics)).not.toContain("must-not-persist");
	});

	it.each([
		{
			code: "rate_limit_exceeded",
			error: { code: "usage_limit_reached", type: "usage_limit_reached" },
			expected: "rate_limit_exceeded",
		},
		{ error: { code: "invalid_token", type: "usage_limit_reached" }, expected: "invalid_token" },
		{ error: { type: "rate_limit_exceeded" }, expected: "rate_limit_exceeded" },
		{ error: { type: "unknown_error" }, expected: "unknown_error" },
		{ error: { type: 429 }, expected: undefined },
		{ error: { message }, expected: undefined },
	])(
		"retains explicit code precedence and does not infer quota from text: $expected",
		async ({ expected, ...fields }) => {
			const result = await stream(model, context, {
				apiKey,
				transport: "sse",
				fetch: eventFetch({ type: "error", ...fields }),
			}).result();
			expect(result.stopReason).toBe("error");
			expect(getOpenAICodexResponseFailure(result)?.code).toBe(expected);
		},
	);

	it("preserves the quota type for native compaction recovery", async () => {
		await expect(
			compactOpenAICodexResponses(model, context, {
				apiKey,
				fetch: eventFetch({ type: "error", error: { type: "usage_limit_reached", message } }),
			}),
		).rejects.toMatchObject({ name: "OpenAICodexNativeCompactionError", code: "usage_limit_reached" });
	});

	it("preserves quota type from a WebSocket error without an HTTP retry", async () => {
		class QuotaSocket extends EventTarget {
			constructor() {
				super();
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}
			send() {
				setTimeout(
					() =>
						this.dispatchEvent(
							new MessageEvent("message", {
								data: JSON.stringify({ type: "error", error: { type: "usage_limit_reached", message } }),
							}),
						),
					0,
				);
			}
			close() {}
		}
		vi.stubGlobal("WebSocket", QuotaSocket);
		const fetch = vi.fn();
		const result = await stream(model, context, { apiKey, transport: "websocket", fetch }).result();
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([]);
		expect(getOpenAICodexResponseFailure(result)?.code).toBe("usage_limit_reached");
		expect(fetch).not.toHaveBeenCalled();
	});
});
