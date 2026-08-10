import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxThinking } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message, Model, Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenAINativeCompactionFunction } from "../../../src/core/agent-session.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const CONTINUATION_INSTRUCTION =
	"Your previous response was cut off by the output limit. Continue exactly where it ended without repeating completed content.";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

function usage(totalTokens: number, output: number): Usage {
	return {
		input: Math.max(0, totalTokens - output),
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(
	content: Parameters<typeof fauxAssistantMessage>[0],
	options: { stopReason?: AssistantMessage["stopReason"]; totalTokens?: number; output?: number } = {},
): AssistantMessage {
	return {
		...fauxAssistantMessage(content, { stopReason: options.stopReason }),
		usage: usage(options.totalTokens ?? 10, options.output ?? 1),
	};
}

function seedConversation(harness: Harness): void {
	const model = harness.session.model!;
	const now = Date.now();
	for (let turn = 0; turn < 2; turn++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: `older user context ${turn} ${"x".repeat(80)}`,
			timestamp: now - 4_000 + turn * 1_000,
		});
		harness.sessionManager.appendMessage({
			...assistant(`older assistant answer ${turn}`),
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: now - 3_500 + turn * 1_000,
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function installResponses(harness: Harness, responses: AssistantMessage[], requests: Message[][]): void {
	harness.session.agent.streamFunction = ((model, context) => {
		requests.push(structuredClone(context.messages));
		const stream = createAssistantMessageEventStream();
		const response = responses.shift();
		if (!response) throw new Error("No synthetic response configured");
		const message = {
			...response,
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
		};
		queueMicrotask(() => {
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} else {
				const reason =
					message.stopReason === "length" || message.stopReason === "toolUse" ? message.stopReason : "stop";
				stream.push({ type: "done", reason, message });
			}
		});
		return stream;
	}) satisfies StreamFn;
}

async function plaintextHarness(): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-1", contextWindow: 200, maxTokens: 100 }],
		settings: { compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "compacted context",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
		],
	});
	harnesses.push(harness);
	seedConversation(harness);
	return harness;
}

async function nativeHarness(compact: OpenAINativeCompactionFunction): Promise<Harness> {
	const harness = await createHarness({
		compactionMode: "openai-native",
		openaiNativeCompaction: compact,
		settings: { compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 1 } },
	});
	harnesses.push(harness);
	Object.assign(harness.session.agent.state.model, {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "gpt-native-test",
		contextWindow: 200,
		maxTokens: 100,
	});
	const model = harness.session.agent.state.model as Model<"openai-codex-responses">;
	harness.session.modelRuntime.registerProvider("openai-codex", {
		baseUrl: model.baseUrl,
		apiKey: "synthetic-key",
		api: model.api,
		models: [model],
	});
	await harness.session.modelRuntime.setRuntimeApiKey("openai-codex", "synthetic-key", { allowNetwork: false });
	seedConversation(harness);
	return harness;
}

function continuationEntries(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && getMessageText(entry) === CONTINUATION_INSTRUCTION);
}

describe("length-stop compaction continuation", () => {
	it("replays a threshold-truncated plaintext turn with no visible assistant text", async () => {
		const harness = await plaintextHarness();
		const requests: Message[][] = [];
		installResponses(
			harness,
			[
				assistant(fauxThinking("reasoning without visible output"), {
					stopReason: "length",
					totalTokens: 190,
					output: 72,
				}),
				assistant("completed after replay"),
			],
			requests,
		);

		await harness.session.prompt("do the work");

		expect(requests).toHaveLength(2);
		expect(requests[1]!.some((message) => getMessageText(message) === CONTINUATION_INSTRUCTION)).toBe(false);
		expect(continuationEntries(harness)).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", aborted: false, willRetry: true }),
		]);
		expect(harness.session.getLastAssistantText()).toBe("completed after replay");
	});

	it("preserves partial plaintext output and continues without replaying it", async () => {
		const harness = await plaintextHarness();
		const requests: Message[][] = [];
		installResponses(
			harness,
			[
				assistant("partial answer already shown", { stopReason: "length", totalTokens: 190, output: 24 }),
				assistant("remaining answer"),
			],
			requests,
		);

		await harness.session.prompt("do the work");

		expect(requests).toHaveLength(2);
		const secondRequestTexts = requests[1]!.map((message) => getMessageText(message));
		expect(secondRequestTexts.filter((text) => text === "partial answer already shown")).toHaveLength(1);
		expect(secondRequestTexts.filter((text) => text === CONTINUATION_INSTRUCTION)).toHaveLength(1);
		expect(secondRequestTexts.indexOf("partial answer already shown")).toBeLessThan(
			secondRequestTexts.indexOf(CONTINUATION_INSTRUCTION),
		);
		expect(continuationEntries(harness)).toEqual([
			expect.objectContaining({ type: "custom_message", display: false }),
		]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", aborted: false, willRetry: true }),
		]);
		expect(harness.session.getLastAssistantText()).toBe("remaining answer");
	});

	it("does not continue natural plaintext stops after threshold compaction", async () => {
		for (const text of ["", "completed answer"]) {
			const harness = await plaintextHarness();
			const requests: Message[][] = [];
			installResponses(harness, [assistant(text, { stopReason: "stop", totalTokens: 190, output: 24 })], requests);

			await harness.session.prompt("do the work");

			expect(requests).toHaveLength(1);
			expect(continuationEntries(harness)).toHaveLength(0);
			expect(harness.eventsOfType("compaction_end")).toEqual([
				expect.objectContaining({ reason: "threshold", aborted: false, willRetry: false }),
			]);
		}
	});

	it("co-delivers queued guidance without reopening the recovery budget", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 200, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						pi.sendUserMessage("user guidance during compaction", { deliverAs: "steer" });
						return {
							compaction: {
								summary: "compacted context",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedConversation(harness);
		const requests: Message[][] = [];
		installResponses(
			harness,
			[
				assistant("partial answer", { stopReason: "length", totalTokens: 190, output: 24 }),
				assistant("still truncated with user guidance", {
					stopReason: "length",
					totalTokens: 190,
					output: 24,
				}),
				assistant("must not be requested"),
			],
			requests,
		);

		await harness.session.prompt("do the work");

		expect(requests).toHaveLength(2);
		const secondRequestTexts = requests[1]!.map((message) => getMessageText(message));
		expect(secondRequestTexts.filter((text) => text === CONTINUATION_INSTRUCTION)).toHaveLength(1);
		expect(secondRequestTexts.filter((text) => text === "user guidance during compaction")).toHaveLength(1);
		expect(secondRequestTexts.indexOf(CONTINUATION_INSTRUCTION)).toBeLessThan(
			secondRequestTexts.indexOf("user guidance during compaction"),
		);
		expect(continuationEntries(harness)).toEqual([
			expect.objectContaining({ type: "custom_message", display: false }),
		]);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.session.getLastAssistantText()).toBe("still truncated with user guidance");
	});

	it("stops after a post-compaction length response that is below threshold", async () => {
		const harness = await plaintextHarness();
		const requests: Message[][] = [];
		installResponses(
			harness,
			[
				assistant("partial answer", { stopReason: "length", totalTokens: 190, output: 24 }),
				assistant("still truncated", { stopReason: "length", totalTokens: 10, output: 5 }),
			],
			requests,
		);

		await harness.session.prompt("do the work");

		expect(requests).toHaveLength(2);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(continuationEntries(harness)).toHaveLength(1);
	});

	it("stops after one recovery when the continued response is still length-truncated above threshold", async () => {
		const harness = await plaintextHarness();
		const requests: Message[][] = [];
		installResponses(
			harness,
			[
				assistant("partial answer", { stopReason: "length", totalTokens: 190, output: 24 }),
				assistant("still truncated", { stopReason: "length", totalTokens: 190, output: 24 }),
				assistant("must not be requested"),
			],
			requests,
		);

		await harness.session.prompt("do the work");

		expect(requests).toHaveLength(2);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(continuationEntries(harness)).toHaveLength(1);
		expect(harness.session.getLastAssistantText()).toBe("still truncated");
	});

	it("does not continue when threshold compaction is cancelled", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 200, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		seedConversation(harness);
		const requests: Message[][] = [];
		installResponses(
			harness,
			[assistant("partial answer", { stopReason: "length", totalTokens: 190, output: 24 })],
			requests,
		);

		await harness.session.prompt("do the work");

		expect(requests).toHaveLength(1);
		expect(continuationEntries(harness)).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", aborted: true, willRetry: false }),
		]);
	});

	it("replays a threshold-truncated native turn with no visible assistant text", async () => {
		const compactedContexts: Message[][] = [];
		const harness = await nativeHarness(async (_model, context) => {
			compactedContexts.push(structuredClone(context.messages));
			return {
				item: { type: "compaction", encrypted_content: "opaque-empty-length" },
				tokensBefore: 190,
				usage: usage(100, 5),
			};
		});
		const requests: Message[][] = [];
		installResponses(
			harness,
			[
				assistant(fauxThinking("reasoning without visible output"), {
					stopReason: "length",
					totalTokens: 190,
					output: 72,
				}),
				assistant("completed after native replay"),
			],
			requests,
		);

		await harness.session.prompt("do the work");

		expect(compactedContexts).toHaveLength(1);
		expect(requests).toHaveLength(2);
		expect(requests[1]).toEqual([]);
		expect(continuationEntries(harness)).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", aborted: false, willRetry: true }),
		]);
	});

	it("preserves partial native output in the checkpoint and continues semantically", async () => {
		const compactedContexts: Message[][] = [];
		const harness = await nativeHarness(async (_model, context) => {
			compactedContexts.push(structuredClone(context.messages));
			return {
				item: { type: "compaction", encrypted_content: "opaque-partial-length" },
				tokensBefore: 190,
				usage: usage(100, 5),
			};
		});
		const requests: Message[][] = [];
		installResponses(
			harness,
			[
				assistant("partial native answer", { stopReason: "length", totalTokens: 190, output: 24 }),
				assistant("remaining native answer"),
			],
			requests,
		);

		await harness.session.prompt("do the work");

		expect(compactedContexts).toHaveLength(1);
		expect(
			compactedContexts[0]!.filter((message) => getMessageText(message) === "partial native answer"),
		).toHaveLength(1);
		expect(requests).toHaveLength(2);
		expect(requests[1]!.map((message) => getMessageText(message))).toEqual([CONTINUATION_INSTRUCTION]);
		expect(continuationEntries(harness)).toEqual([
			expect.objectContaining({ type: "custom_message", display: false }),
		]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", aborted: false, willRetry: true }),
		]);
	});
});
