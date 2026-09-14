import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message, Model, Usage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function usage(input: number): Usage {
	return {
		input,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

async function scenario(
	native: boolean,
	options: { input: number; output?: string; fail?: boolean; terminate?: boolean; enabled?: boolean; queue?: boolean },
) {
	let harness: Harness;
	const compacted: Message[][] = [];
	const recordCompaction = () => {
		compacted.push(structuredClone(harness.session.messages) as Message[]);
	};
	harness = await createHarness({
		models: [{ id: "faux-1", contextWindow: 4096, maxTokens: 256 }],
		compactionMode: native ? "openai-native" : undefined,
		settings: { compaction: { enabled: options.enabled ?? true, reserveTokens: 128, keepRecentTokens: 256 } },
		tools: [
			{
				name: "record",
				label: "Record",
				description: "Record a completed effect",
				parameters: Type.Object({ value: Type.String() }),
				execute: async (_id, args) => {
					const { value } = args as { value: string };
					appendFileSync(join(harness.tempDir, "effects.txt"), `${value}\n`);
					if (options.queue && value === "one")
						await harness.session.prompt("Keep the receipts.", { streamingBehavior: "steer" });
					return {
						content: [{ type: "text", text: options.output ?? `Recorded ${value}` }],
						details: {},
						terminate: options.terminate,
					};
				},
			},
		],
		openaiNativeCompaction: async () => {
			recordCompaction();
			if (options.fail) throw new Error("Synthetic compaction failure");
			return {
				item: { type: "compaction", encrypted_content: "synthetic-checkpoint" },
				tokensBefore: options.input,
				usage: usage(100),
			};
		},
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					recordCompaction();
					if (options.fail) return { cancel: true };
					return {
						compaction: {
							summary: "Both requested effects completed.",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		],
	});
	harnesses.push(harness);
	if (native) {
		Object.assign(harness.session.agent.state.model, {
			provider: "openai-codex",
			api: "openai-codex-responses",
			id: "gpt-native-test",
		});
		const model = harness.session.model as Model<"openai-codex-responses">;
		harness.session.modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "synthetic",
			api: model.api,
			models: [model],
		});
		await harness.session.modelRuntime.setRuntimeApiKey(model.provider, "synthetic", { allowNetwork: false });
	}
	for (let i = 0; i < 2; i++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: `Earlier request ${i} ${"x".repeat(1500)}`,
			timestamp: 1 + i,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage(`Earlier answer ${i}`),
			api: harness.session.model!.api,
			provider: harness.session.model!.provider,
			model: harness.session.model!.id,
			timestamp: 3 + i,
			usage: usage(100),
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	const requests: { compacted: boolean; messages: Message[] }[] = [];
	const responses: AssistantMessage[] = [
		{
			...fauxAssistantMessage([fauxToolCall("record", { value: "one" }), fauxToolCall("record", { value: "two" })]),
			stopReason: "toolUse",
			usage: usage(options.input),
		},
		{ ...fauxAssistantMessage("Both effects are complete."), usage: usage(200) },
	];
	harness.session.agent.streamFunction = ((model, context) => {
		requests.push({
			compacted: harness.eventsOfType("compaction_end").some((e) => !!e.result),
			messages: structuredClone(context.messages),
		});
		const response = responses.shift();
		if (!response) throw new Error("Unexpected provider request");
		const message = { ...response, provider: model.provider, api: model.api, model: model.id, timestamp: Date.now() };
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() =>
			stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }),
		);
		return stream;
	}) satisfies StreamFn;
	await harness.session.prompt("Record one and two, then report completion.");
	return {
		harness,
		requests,
		compacted,
		effects: readFileSync(join(harness.tempDir, "effects.txt"), "utf8").trim().split("\n").sort(),
	};
}

describe.each([false, true])("compaction at tool boundaries (native=%s)", (native) => {
	it("preserves steering queued during a tool batch across compaction", async () => {
		const result = await scenario(native, { input: 3800, output: "x".repeat(800), queue: true });
		expect(result.effects).toEqual(["one", "two"]);
		expect(result.requests.map((r) => r.compacted)).toEqual([false, true]);
		expect(result.requests[1]?.messages.filter((m) => getMessageText(m) === "Keep the receipts.")).toHaveLength(1);
	});
	it("compacts a successful oversized tool response before continuing and keeps completed effects", async () => {
		const result = await scenario(native, { input: 4500 });
		expect(result.effects).toEqual(["one", "two"]);
		expect(result.requests.map((r) => r.compacted)).toEqual([false, true]);
		expect(
			result.compacted[0]
				?.filter((m) => m.role === "toolResult")
				.map(getMessageText)
				.sort(),
		).toEqual(["Recorded one", "Recorded two"]);
		expect(result.harness.session.getLastAssistantText()).toBe("Both effects are complete.");
	});
	it("counts completed tool output toward the compaction threshold", async () => {
		const result = await scenario(native, { input: 3800, output: "x".repeat(800) });
		expect(result.requests.map((r) => r.compacted)).toEqual([false, true]);
		expect(result.harness.eventsOfType("compaction_end")[0]?.reason).toBe("threshold");
	});
	it("stops without another oversized request when compaction fails", async () => {
		const result = await scenario(native, { input: 4500, fail: true });
		expect(result.effects).toEqual(["one", "two"]);
		expect(result.requests).toHaveLength(1);
		if (native)
			expect(result.harness.eventsOfType("compaction_end")[0]?.errorMessage).toContain(
				"Synthetic compaction failure",
			);
		else expect(result.harness.eventsOfType("compaction_end")[0]?.aborted).toBe(true);
		expect(
			result.harness.sessionManager
				.getEntries()
				.filter((e) => e.type === "message" && e.message.role === "toolResult"),
		).toHaveLength(2);
	});
	it("respects tools that finish the run", async () => {
		const result = await scenario(native, { input: 4500, terminate: true });
		expect(result.effects).toEqual(["one", "two"]);
		expect(result.requests).toHaveLength(1);
	});
	it("respects disabled auto-compaction", async () => {
		const result = await scenario(native, { input: 4500, enabled: false });
		expect(result.requests.map((r) => r.compacted)).toEqual([false, false]);
		expect(result.compacted).toEqual([]);
	});
});
