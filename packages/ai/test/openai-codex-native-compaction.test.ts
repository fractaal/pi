import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	compactOpenAICodexResponses,
	OpenAICodexNativeCompactionError,
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
	contextWindow: 400000,
	maxTokens: 128000,
};

const context: Context = {
	systemPrompt: "Be concise.",
	messages: [{ role: "user", content: "Synthetic context", timestamp: 1 }],
};

function token(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function responseBody(items: unknown[], status: "completed" | "incomplete" = "completed"): string {
	const events = [
		...items.map((item) => ({ type: "response.output_item.done", item })),
		{
			type: `response.${status}`,
			response: {
				status,
				usage: {
					input_tokens: 12,
					output_tokens: 2,
					total_tokens: 14,
					input_tokens_details: { cached_tokens: 5 },
				},
			},
		},
	];
	return `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

function mockResponse(
	items: unknown[],
	inspectBody?: (body: Record<string, unknown>) => void,
	status?: "completed" | "incomplete",
): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const encoded = init?.body;
			const text =
				encoded instanceof Uint8Array ? Buffer.from(zstdDecompressSync(encoded)).toString("utf8") : String(encoded);
			inspectBody?.(JSON.parse(text) as Record<string, unknown>);
			return new Response(responseBody(items, status), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}),
	);
}

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("OpenAI Codex native compaction", () => {
	it("compacts and resumes over the same WebSocket with rewritten history", async () => {
		let connections = 0;
		const requests: Array<{ input: Array<{ type?: string }>; previous_response_id?: string }> = [];
		class Socket extends EventTarget {
			readyState = 1;
			constructor() {
				super();
				connections++;
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}
			close() {
				this.readyState = 3;
			}
			send(data: string) {
				const request = JSON.parse(data) as (typeof requests)[number];
				requests.push(request);
				const items = request.input.some((item) => item.type === "compaction_trigger")
					? [{ type: "compaction", encrypted_content: "socket-checkpoint" }]
					: [];
				setTimeout(() => {
					for (const event of responseBody(items).trim().split("\n\n"))
						this.dispatchEvent(new MessageEvent("message", { data: event.slice(6) }));
				}, 0);
			}
		}
		vi.stubGlobal("WebSocket", Socket);
		const fetch = vi.fn(async () => {
			throw new Error("Unexpected HTTP request");
		});
		vi.stubGlobal("fetch", fetch);
		const options = { apiKey: token(), transport: "websocket-cached" as const, sessionId: "native-socket-test" };
		const checkpoint = await compactOpenAICodexResponses(model, context, options);
		const result = await streamSimple(
			model,
			{ messages: [] },
			{ ...options, nativeCompactionCheckpoint: { ...checkpoint, provider: "openai-codex", modelId: model.id } },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(connections).toBe(1);
		expect(fetch).not.toHaveBeenCalled();
		expect(requests[1]?.previous_response_id).toBeUndefined();
		expect(requests[1]?.input).toEqual([...checkpoint.retainedInput!, checkpoint.item]);
	});
	it("retains recent instructions across repeated compaction and replays them before the new checkpoint", async () => {
		const previous = {
			provider: "openai-codex" as const,
			modelId: "gpt-other",
			item: { type: "compaction" as const, encrypted_content: "old" },
			retainedInput: [{ role: "user" as const, content: "Use pnpm." }],
		};
		mockResponse([{ type: "compaction", encrypted_content: "next" }]);
		const result = await compactOpenAICodexResponses(model, context, {
			apiKey: token(),
			transport: "sse",
			nativeCompactionCheckpoint: previous,
		});
		expect(result.retainedInput).toEqual([
			{ role: "user", content: "Use pnpm." },
			{ role: "user", content: [{ type: "input_text", text: "Synthetic context" }] },
		]);
		mockResponse([], (body) =>
			expect(body.input).toEqual([
				...result.retainedInput!,
				result.item,
				{ role: "user", content: [{ type: "input_text", text: "Continue." }] },
			]),
		);
		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "Continue.", timestamp: 2 }] },
			{
				apiKey: token(),
				transport: "sse",
				nativeCompactionCheckpoint: JSON.parse(JSON.stringify({ ...previous, ...result })),
			},
		).result();
	});

	it("bounds readable history while preserving the newest instruction and Unicode", async () => {
		mockResponse([{ type: "compaction", encrypted_content: "next" }]);
		const result = await compactOpenAICodexResponses(
			model,
			{
				messages: [
					{ role: "user", content: "discard this older message", timestamp: 1 },
					{ role: "user", content: "🦊".repeat(64_001), timestamp: 2 },
					{ role: "user", content: "Keep the receipts.", timestamp: 3 },
				],
			},
			{ apiKey: token(), transport: "sse" },
		);
		const serialized = JSON.stringify(result.retainedInput);
		expect(serialized).not.toContain("discard this older message");
		expect(serialized).toContain("Keep the receipts.");
		expect(serialized).not.toContain("�");
		expect(Buffer.byteLength(serialized)).toBeLessThan(257_000);
	});

	it("trims oversized trailing tool output only in the compaction request", async () => {
		const history: Context = {
			messages: [
				{ role: "user", content: "inspect", timestamp: 1 },
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "inspect",
					content: [
						{ type: "text", text: "x".repeat(40_000) },
						{ type: "image", data: "synthetic", mimeType: "image/png" },
					],
					isError: false,
					timestamp: 2,
				},
			],
		};
		const before = structuredClone(history);
		mockResponse([{ type: "compaction", encrypted_content: "next" }], (body) => {
			expect(body.input).toContainEqual({
				type: "function_call_output",
				call_id: "call_1",
				output: "Output exceeded the available model context and was truncated",
			});
		});
		const result = await compactOpenAICodexResponses({ ...model, contextWindow: 4_000 }, history, {
			apiKey: token(),
			transport: "sse",
		});
		expect(result.retainedInput).toEqual([{ role: "user", content: [{ type: "input_text", text: "inspect" }] }]);
		expect(history).toEqual(before);
	});

	it("discards a partial checkpoint and retries a transient stream failure", async () => {
		vi.useFakeTimers();
		let attempts = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				attempts++;
				const body =
					attempts === 1
						? `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "partial" } })}\n\ndata: ${JSON.stringify({ type: "error", error: { code: "server_error", message: "server error" } })}\n\n`
						: responseBody([{ type: "compaction", encrypted_content: "complete" }]);
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			}),
		);
		const pending = compactOpenAICodexResponses(model, context, { apiKey: token(), transport: "sse" });
		await vi.runAllTimersAsync();
		expect((await pending).item.encrypted_content).toBe("complete");
		expect(attempts).toBe(2);
	});

	it("stops after two native stream retries", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn(async () => {
			throw new Error("fetch failed");
		});
		vi.stubGlobal("fetch", fetch);
		const result = compactOpenAICodexResponses(model, context, { apiKey: token(), transport: "sse" }).catch(
			(error: unknown) => error,
		);
		await vi.runAllTimersAsync();
		expect(await result).toBeInstanceOf(OpenAICodexNativeCompactionError);
		expect(fetch).toHaveBeenCalledTimes(3);
	});
	it("sends one compaction trigger and returns the validated opaque item", async () => {
		mockResponse([{ type: "compaction", id: "cmp_1", encrypted_content: "opaque-checkpoint" }], (body) => {
			const input = body.input as Array<{ type?: string }>;
			expect(input.filter((item) => item.type === "compaction_trigger")).toHaveLength(1);
			expect(body.model).toBe("gpt-5.6-sol");
		});

		await expect(compactOpenAICodexResponses(model, context, { apiKey: token(), transport: "sse" })).resolves.toEqual(
			{
				item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque-checkpoint" },
				retainedInput: [{ role: "user", content: [{ type: "input_text", text: "Synthetic context" }] }],
				tokensBefore: 12,
				usage: {
					input: 7,
					output: 2,
					reasoning: 0,
					cacheRead: 5,
					cacheWrite: 0,
					totalTokens: 14,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		);
	});

	it("replays the exact opaque checkpoint before later messages", async () => {
		mockResponse([{ type: "compaction", encrypted_content: "next-checkpoint" }], (body) => {
			expect(body.input).toEqual([
				{ type: "compaction", id: "cmp_1", encrypted_content: "opaque-checkpoint" },
				{ role: "user", content: [{ type: "input_text", text: "Synthetic context" }] },
				{ type: "compaction_trigger" },
			]);
		});

		await compactOpenAICodexResponses(model, context, {
			apiKey: token(),
			transport: "sse",
			nativeCompactionCheckpoint: {
				provider: "openai-codex",
				modelId: "gpt-5.6-sol",
				item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque-checkpoint" },
			},
		});
	});

	it("replays through another Codex model", async () => {
		mockResponse([{ type: "compaction", encrypted_content: "next" }]);
		await expect(
			compactOpenAICodexResponses({ ...model, id: "gpt-other" }, context, {
				apiKey: token(),
				transport: "sse",
				nativeCompactionCheckpoint: {
					provider: "openai-codex",
					modelId: "gpt-5.6-sol",
					item: { type: "compaction", encrypted_content: "opaque-checkpoint" },
				},
			}),
		).resolves.toMatchObject({ item: { encrypted_content: "next" } });
	});

	it.each([
		["missing", []],
		[
			"multiple",
			[
				{ type: "compaction", encrypted_content: "one" },
				{ type: "compaction", encrypted_content: "two" },
			],
		],
	])("rejects %s checkpoint output", async (_name, items) => {
		mockResponse(items);
		await expect(compactOpenAICodexResponses(model, context, { apiKey: token(), transport: "sse" })).rejects.toThrow(
			/expected exactly one/,
		);
	});

	it("rejects a checkpoint item from an incomplete response", async () => {
		mockResponse(
			[{ type: "compaction", id: "cmp_incomplete", encrypted_content: "opaque" }],
			undefined,
			"incomplete",
		);
		await expect(compactOpenAICodexResponses(model, context, { apiKey: token(), transport: "sse" })).rejects.toThrow(
			/did not complete \(length\)/,
		);
	});

	it("preserves a typed provider code when compaction fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						`data: ${JSON.stringify({
							type: "error",
							error: { code: "usage_limit_reached", message: "private upstream detail" },
						})}\n\n`,
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			),
		);

		const error = await compactOpenAICodexResponses(model, context, { apiKey: token(), transport: "sse" }).catch(
			(reason: unknown) => reason,
		);
		expect(error).toBeInstanceOf(OpenAICodexNativeCompactionError);
		expect(error).toMatchObject({
			name: "OpenAICodexNativeCompactionError",
			code: "usage_limit_reached",
			status: undefined,
		});
	});

	it("rejects malformed checkpoint output", async () => {
		mockResponse([{ type: "compaction", encrypted_content: "" }]);
		await expect(compactOpenAICodexResponses(model, context, { apiKey: token(), transport: "sse" })).rejects.toThrow(
			/malformed/,
		);
	});
});
