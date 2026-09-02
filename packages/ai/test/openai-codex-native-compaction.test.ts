import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactOpenAICodexResponses, OpenAICodexNativeCompactionError } from "../src/api/openai-codex-responses.ts";
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
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("OpenAI Codex native compaction", () => {
	it("sends one compaction trigger and returns the validated opaque item", async () => {
		mockResponse([{ type: "compaction", id: "cmp_1", encrypted_content: "opaque-checkpoint" }], (body) => {
			const input = body.input as Array<{ type?: string }>;
			expect(input.filter((item) => item.type === "compaction_trigger")).toHaveLength(1);
			expect(body.model).toBe("gpt-5.6-sol");
		});

		await expect(
			compactOpenAICodexResponses(model, context, { apiKey: token(), transport: "websocket-cached" }),
		).resolves.toEqual({
			item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque-checkpoint" },
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
		});
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
			nativeCompactionCheckpoint: {
				provider: "openai-codex",
				modelId: "gpt-5.6-sol",
				item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque-checkpoint" },
			},
		});
	});

	it("rejects replay through a different Codex model", async () => {
		await expect(
			compactOpenAICodexResponses({ ...model, id: "gpt-other" }, context, {
				apiKey: token(),
				nativeCompactionCheckpoint: {
					provider: "openai-codex",
					modelId: "gpt-5.6-sol",
					item: { type: "compaction", encrypted_content: "opaque-checkpoint" },
				},
			}),
		).rejects.toThrow(/requires openai-codex\/gpt-5\.6-sol/);
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
		await expect(compactOpenAICodexResponses(model, context, { apiKey: token() })).rejects.toThrow(
			/expected exactly one/,
		);
	});

	it("rejects a checkpoint item from an incomplete response", async () => {
		mockResponse(
			[{ type: "compaction", id: "cmp_incomplete", encrypted_content: "opaque" }],
			undefined,
			"incomplete",
		);
		await expect(compactOpenAICodexResponses(model, context, { apiKey: token() })).rejects.toThrow(
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

		const error = await compactOpenAICodexResponses(model, context, { apiKey: token() }).catch(
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
		await expect(compactOpenAICodexResponses(model, context, { apiKey: token() })).rejects.toThrow(/malformed/);
	});
});
