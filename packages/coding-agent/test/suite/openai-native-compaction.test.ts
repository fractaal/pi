import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenAINativeCompactionFunction } from "../../src/core/agent-session.ts";
import { hasRestorableSessionContext, SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function assistant(modelId: string, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: modelId,
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
	};
}

function nativeUsage(): Usage {
	return {
		input: 200,
		output: 5,
		cacheRead: 40,
		cacheWrite: 0,
		totalTokens: 245,
		cost: { input: 0.2, output: 0.01, cacheRead: 0.02, cacheWrite: 0, total: 0.23 },
	};
}

function responseStream(responses: AssistantMessage[]): StreamFn {
	return () => {
		const stream = createAssistantMessageEventStream();
		const message = responses.shift();
		if (!message) throw new Error("No synthetic response configured");
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} else {
				const reason =
					message.stopReason === "length" || message.stopReason === "toolUse" ? message.stopReason : "stop";
				stream.push({ type: "done", reason, message });
			}
			stream.end();
		});
		return stream;
	};
}

function seedConversation(harness: Harness): void {
	const modelId = harness.session.model!.id;
	for (let turn = 0; turn < 2; turn++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: `synthetic user context ${turn} ${"x".repeat(80)}`,
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage(assistant(modelId, `synthetic answer ${turn}`));
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

async function nativeHarness(compact: OpenAINativeCompactionFunction, seed = true): Promise<Harness> {
	const harness = await createHarness({
		compactionMode: "openai-native",
		openaiNativeCompaction: compact,
		settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
	});
	harnesses.push(harness);
	Object.assign(harness.session.agent.state.model!, {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "gpt-native-test",
		contextWindow: 200,
	});
	const nativeModel = harness.session.agent.state.model! as Model<"openai-codex-responses">;
	harness.session.modelRuntime.registerProvider("openai-codex", {
		baseUrl: nativeModel.baseUrl,
		apiKey: "synthetic-key",
		api: nativeModel.api,
		models: [nativeModel],
	});
	await harness.session.modelRuntime.setRuntimeApiKey("openai-codex", "synthetic-key", { allowNetwork: false });
	if (seed) seedConversation(harness);
	return harness;
}

describe("AgentSession OpenAI native compaction", () => {
	it("persists one opaque checkpoint only after provider success", async () => {
		const compact = vi.fn(async (_model: Model<"openai-codex-responses">, context: { messages: unknown[] }) => {
			expect(context.messages).toHaveLength(4);
			return {
				item: { type: "compaction" as const, id: "cmp_1", encrypted_content: "opaque" },
				tokensBefore: 240,
				usage: nativeUsage(),
			};
		});
		const harness = await nativeHarness(compact);

		const result = await harness.session.compact();

		expect(compact).toHaveBeenCalledTimes(1);
		expect(result.summary).toBe("OpenAI native checkpoint");
		const checkpoint = harness.sessionManager.getBranch().at(-1);
		expect(checkpoint).toMatchObject({
			type: "openai_native_compaction",
			provider: "openai-codex",
			modelId: "gpt-native-test",
			item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
			tokensBefore: 240,
			usage: nativeUsage(),
		});
		expect(result.usage).toEqual(nativeUsage());
		expect(harness.session.getSessionStats()).toMatchObject({
			tokens: { input: 360, output: 45, cacheRead: 40, cacheWrite: 0, total: 445 },
			cost: 0.23,
		});
		expect(harness.session.messages).toEqual([]);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
	});

	it("detects threshold usage and compacts before the next public prompt", async () => {
		const harness = await nativeHarness(async () => ({
			item: { type: "compaction", encrypted_content: "opaque-threshold" },
			tokensBefore: 180,
			usage: nativeUsage(),
		}));
		const lastAssistant = harness.session.messages.at(-1) as AssistantMessage;
		lastAssistant.usage.totalTokens = 180;
		lastAssistant.usage.input = 180;
		harness.session.agent.streamFunction = responseStream([assistant("gpt-native-test", "continued")]);

		await harness.session.prompt("continue after threshold");

		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "openai_native_compaction")).toBe(true);
		expect(harness.eventsOfType("compaction_start")).toEqual([expect.objectContaining({ reason: "threshold" })]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", result: expect.any(Object), willRetry: false }),
		]);
	});

	it("compacts successful overflow responses without retrying through the public prompt path", async () => {
		const harness = await createHarness({
			compactionMode: "openai-native",
			openaiNativeCompaction: async () => ({
				item: { type: "compaction", encrypted_content: "opaque-overflow" },
				tokensBefore: 240,
				usage: nativeUsage(),
			}),
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "gpt-native-test", contextWindow: 1, maxTokens: 100 }],
		});
		harnesses.push(harness);
		harness.session.agent.streamFunction = (model) => {
			const stream = createAssistantMessageEventStream();
			Object.assign(model, { provider: "openai-codex", api: "openai-codex-responses" });
			const response = assistant(model.id, "completed answer");
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: response });
			});
			return stream;
		};

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		expect(harness.eventsOfType("compaction_start")).toEqual([expect.objectContaining({ reason: "overflow" })]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "overflow", result: expect.any(Object), willRetry: false }),
		]);
		expect(
			harness.sessionManager.getEntries().filter((entry) => entry.type === "openai_native_compaction"),
		).toHaveLength(1);
		expect(harness.session.messages).toEqual([]);
	});

	it("retries an overflow error from the opaque checkpoint without a generic checkpoint message", async () => {
		const harness = await nativeHarness(async () => ({
			item: { type: "compaction", encrypted_content: "opaque-overflow-retry" },
			tokensBefore: 240,
			usage: nativeUsage(),
		}));
		harness.session.model!.contextWindow = 100_000;
		const overflow = {
			...assistant("gpt-native-test", ""),
			stopReason: "error" as const,
			errorMessage: "Your input exceeds the context window of this model",
		};
		harness.session.agent.streamFunction = responseStream([
			overflow,
			assistant("gpt-native-test", "continued after native overflow"),
		]);

		await harness.session.prompt("trigger an overflow retry");

		expect(harness.eventsOfType("compaction_start")).toEqual([expect.objectContaining({ reason: "overflow" })]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "overflow", result: expect.any(Object), willRetry: true }),
		]);
		expect(
			harness.sessionManager.getEntries().filter((entry) => entry.type === "openai_native_compaction"),
		).toHaveLength(1);
		expect(harness.session.messages).toEqual([
			expect.objectContaining({
				role: "assistant",
				content: [{ type: "text", text: "continued after native overflow" }],
			}),
		]);
	});

	it("delivers steering queued during threshold compaction from a checkpoint-only context", async () => {
		let notifyCompactionStarted: () => void = () => undefined;
		const compactionStarted = new Promise<void>((resolve) => {
			notifyCompactionStarted = resolve;
		});
		let releaseCompaction: () => void = () => undefined;
		const compactionCanFinish = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await nativeHarness(async () => {
			notifyCompactionStarted();
			await compactionCanFinish;
			return {
				item: { type: "compaction", encrypted_content: "opaque-threshold-queue" },
				tokensBefore: 180,
				usage: nativeUsage(),
			};
		}, false);
		const initialResponse = assistant("gpt-native-test", "response before compaction");
		initialResponse.usage.input = 180;
		initialResponse.usage.totalTokens = 180;
		const responses = [initialResponse, assistant("gpt-native-test", "response after compaction")];
		let requestCount = 0;
		let queuedMessageCount = 0;
		harness.session.agent.streamFunction = (_model, context) => {
			requestCount += 1;
			if (requestCount === 2) {
				queuedMessageCount = context.messages.filter(
					(message) => getMessageText(message) === "deliver after checkpoint",
				).length;
			}
			const stream = createAssistantMessageEventStream();
			const response = responses.shift();
			if (!response) throw new Error("No synthetic response configured");
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: response }));
			return stream;
		};

		const prompt = harness.session.prompt("trigger threshold compaction");
		await compactionStarted;
		await harness.session.prompt("deliver after checkpoint", { streamingBehavior: "steer" });
		releaseCompaction();

		await expect(prompt).resolves.toBeUndefined();
		expect(requestCount).toBe(2);
		expect(queuedMessageCount).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(
			harness.sessionManager
				.getEntries()
				.filter(
					(entry) => entry.type === "message" && getMessageText(entry.message) === "deliver after checkpoint",
				),
		).toHaveLength(1);
	});

	it("bypasses text compaction extension hooks in native mode", async () => {
		const beforeCompact = vi.fn();
		const harness = await createHarness({
			compactionMode: "openai-native",
			openaiNativeCompaction: async () => ({
				item: { type: "compaction", encrypted_content: "opaque" },
				tokensBefore: 240,
				usage: nativeUsage(),
			}),
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", beforeCompact);
				},
			],
		});
		harnesses.push(harness);
		Object.assign(harness.session.agent.state.model!, {
			provider: "openai-codex",
			api: "openai-codex-responses",
			id: "gpt-native-test",
		});
		seedConversation(harness);

		await harness.session.compact();
		expect(beforeCompact).not.toHaveBeenCalled();
	});

	it("leaves durable and active state unchanged when provider compaction fails", async () => {
		const harness = await nativeHarness(async () => {
			throw new Error("malformed checkpoint");
		});
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());
		const messagesBefore = structuredClone(harness.session.messages);

		await expect(harness.session.compact()).rejects.toThrow("malformed checkpoint");

		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(harness.session.messages).toEqual(messagesBefore);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ result: undefined, errorMessage: expect.stringContaining("malformed checkpoint") }),
		]);
	});

	it("allows model changes before a checkpoint and locks the exact model after one", async () => {
		const harness = await createHarness({
			compactionMode: "openai-native",
			models: [{ id: "model-a" }, { id: "model-b" }],
		});
		harnesses.push(harness);
		const modelB = harness.getModel("model-b")!;
		await expect(harness.session.setModel(modelB)).resolves.toBeUndefined();

		harness.sessionManager.appendOpenAINativeCompaction(
			"model-b",
			{
				type: "compaction",
				encrypted_content: "opaque",
			},
			100,
			nativeUsage(),
		);
		await expect(harness.session.setModel(harness.getModel("model-a")!)).rejects.toThrow(
			/locked to openai-codex\/model-b/,
		);
		await expect(harness.session.cycleModel()).resolves.toBeUndefined();
	});

	it("restores the checkpoint model when navigating back to a native-compacted branch", async () => {
		const harness = await createHarness({
			compactionMode: "openai-native",
			models: [{ id: "model-a" }, { id: "model-b" }],
		});
		harnesses.push(harness);
		const checkpointModel = {
			...harness.getModel("model-a")!,
			provider: "openai-codex",
			api: "openai-codex-responses" as const,
		};
		harness.session.modelRuntime.registerProvider("openai-codex", {
			baseUrl: checkpointModel.baseUrl,
			apiKey: "synthetic-key",
			api: checkpointModel.api,
			models: [checkpointModel],
		});
		const beforeCheckpointId = harness.sessionManager.appendMessage(assistant("model-a", "before checkpoint"));
		const checkpointId = harness.sessionManager.appendOpenAINativeCompaction(
			"model-a",
			{ type: "compaction", encrypted_content: "opaque-branch" },
			100,
			nativeUsage(),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		await harness.session.navigateTree(beforeCheckpointId);
		await harness.session.setModel(harness.getModel("model-b")!);
		await harness.session.navigateTree(checkpointId);
		harness.session.agent.streamFunction = responseStream([assistant("model-a", "continued after branch restore")]);

		await harness.session.prompt("continue from restored checkpoint branch");

		expect(harness.session.model).toMatchObject({ provider: "openai-codex", id: "model-a" });
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", model: "model-a" });
	});

	it("replays the latest checkpoint after restart and preserves the mode across a fork", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-native-session-"));
		tempDirs.push(dir);
		const path = join(dir, "native.jsonl");
		const manager = SessionManager.open(path, dir, dir, { compactionMode: "openai-native" });
		manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
		manager.appendMessage(assistant("gpt-native", "before answer"));
		const checkpointId = manager.appendOpenAINativeCompaction(
			"gpt-native",
			{ type: "compaction", encrypted_content: "opaque-restart" },
			100,
			nativeUsage(),
		);
		expect(manager.buildSessionContext().messages).toEqual([]);
		expect(hasRestorableSessionContext(manager.buildSessionContext(), manager.getBranch())).toBe(true);
		manager.appendMessage({ role: "user", content: "after", timestamp: 2 });

		const restarted = SessionManager.open(path);
		expect(restarted.getHeader()?.compactionMode).toBe("openai-native");
		expect(restarted.buildSessionContext().messages.map((message) => message.role)).toEqual(["user"]);
		restarted.createBranchedSession(restarted.getLeafId()!);
		expect(restarted.getHeader()?.compactionMode).toBe("openai-native");
		expect(restarted.getBranch().some((entry) => entry.id === checkpointId)).toBe(true);
	});

	it("does not apply a newly enabled mode to an existing legacy session", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-legacy-session-"));
		tempDirs.push(dir);
		const path = join(dir, "legacy.jsonl");
		const legacy = SessionManager.open(path, dir, dir);
		legacy.appendMessage({ role: "user", content: "legacy", timestamp: 1 });
		legacy.appendMessage(assistant("legacy-model", "answer"));

		const reopened = SessionManager.open(path, dir, dir, { compactionMode: "openai-native" });
		expect(reopened.getHeader()?.compactionMode).toBeUndefined();
	});

	it("rejects native execution on an ineligible current provider without calling the capability", async () => {
		const compact = vi.fn();
		const harness = await createHarness({
			compactionMode: "openai-native",
			openaiNativeCompaction: compact,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedConversation(harness);
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());

		await expect(harness.session.compact()).rejects.toThrow(/requires the openai-codex Responses route/);
		expect(compact).not.toHaveBeenCalled();
		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
	});
});
