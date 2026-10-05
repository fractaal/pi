import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_enterCompactionBarrier: (reason: "manual" | "overflow" | "threshold", willRetry: boolean) => void;
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(
	harness: Harness,
	summary: string,
	onRequest?: (context: TranscriptContext, options: SimpleStreamOptions | undefined) => void,
): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model, context, options) => {
		callCount++;
		onRequest?.(context, options);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

async function createAbortableCompactionHarness(): Promise<{
	harness: Harness;
	compactionStarted: Promise<void>;
}> {
	let markCompactionStarted = () => {};
	const compactionStarted = new Promise<void>((resolve) => {
		markCompactionStarted = resolve;
	});
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					return await new Promise<{ cancel: true }>((resolve) => {
						event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						markCompactionStarted();
					});
				});
			},
		],
	});
	seedCompactableSession(harness);
	return { harness, compactionStarted };
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const summaryUsage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							usage: summaryUsage,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const statsBefore = harness.session.getSessionStats();

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const estimatedTokensAfter = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

		expect(result.summary).toBe("summary from extension");
		expect(result.usage).toEqual(summaryUsage);
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(compactionEntries).toHaveLength(1);
		const compactionEntry = compactionEntries[0];
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.usage).toEqual(summaryUsage);
		}
		const statsAfter = harness.session.getSessionStats();
		expect(statsAfter.tokens.input).toBe(statsBefore.tokens.input + summaryUsage.input);
		expect(statsAfter.tokens.output).toBe(statsBefore.tokens.output + summaryUsage.output);
		expect(statsAfter.tokens.cacheRead).toBe(statsBefore.tokens.cacheRead + summaryUsage.cacheRead);
		expect(statsAfter.tokens.cacheWrite).toBe(statsBefore.tokens.cacheWrite + summaryUsage.cacheWrite);
		expect(statsAfter.cost).toBe(statsBefore.cost + summaryUsage.cost.total);
		expect(harness.session.messages[0]?.role).toBe("system");
		expect(harness.session.messages[1]?.role).toBe("compactionSummary");
	});

	it("checkpoints the replayed system state and folds summarized and retained system patches into it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("declared")]);
		await harness.session.prompt("declare the prompt");
		const declared = harness.session.messages[0];
		if (declared?.role !== "system") throw new Error("expected declared system message");

		harness.sessionManager.appendMessage({
			role: "system",
			content: "summarized instruction",
			sections: { early: "<early>1</early>" },
			toolsRemoved: [{ name: "bash" }],
			timestamp: Date.now(),
		});
		const firstKeptEntryId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept before patch" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage({
			role: "system",
			content: "retained instruction",
			sections: { extra: "<extra>late</extra>" },
			toolsRemoved: [{ name: "read" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept after patch" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendCompaction("compacted", firstKeptEntryId, 100);

		const messages = harness.sessionManager.buildSessionContext().messages;
		expect(messages.map((message) => message.role)).toEqual(["system", "compactionSummary", "user", "user"]);
		const checkpoint = messages[0];
		if (checkpoint?.role !== "system") throw new Error("expected checkpoint system message");
		expect(checkpoint.content).toBe("summarized instruction\n\nretained instruction");
		expect(checkpoint.sections).toEqual({
			...declared.sections,
			early: "<early>1</early>",
			extra: "<extra>late</extra>",
		});
		expect(checkpoint.toolsAdded?.map((tool) => tool.name)).toEqual(
			harness.session.getActiveToolNames().filter((name) => name !== "read" && name !== "bash"),
		);
	});

	it("allows a queued prompt to start when manual compaction ends", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "manual compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("queued response")]);

		let queuedPrompt: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "manual" && event.result) {
				// The stop-the-world barrier is still up while compaction_end listeners run, so the prompt
				// is parked and released right after the listeners return.
				queuedPrompt = harness.session.prompt("queued after compaction");
			}
		});

		await harness.session.compact();
		if (!queuedPrompt) throw new Error("compaction_end did not start the queued prompt");
		await queuedPrompt;

		expect(getUserTexts(harness)).toContain("queued after compaction");
		expect(harness.session.getLastAssistantText()).toBe("queued response");
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		// Auth is resolved only when Pi summarizes itself, after checking there is something to compact.
		seedCompactableSession(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("manually compacts with provider-resolved bearer auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const model = harness.getModel();
		harness.session.modelRuntime.registerNativeProvider({
			id: model.provider,
			name: "Faux bearer provider",
			auth: {
				apiKey: {
					name: "Faux bearer token",
					resolve: async () => ({
						auth: { headers: { Authorization: "Bearer ambient-token" } },
						source: "ambient bearer token",
					}),
				},
			},
			getModels: () => harness.models,
			stream: () => createAssistantMessageEventStream(),
			streamSimple: () => createAssistantMessageEventStream(),
		});
		seedCompactableSession(harness);
		const summaryResponse = (_context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
			expect(options?.apiKey).toBeUndefined();
			expect(options?.headers).toEqual({ Authorization: "Bearer ambient-token" });
			return fauxAssistantMessage("summary with bearer auth");
		};
		harness.setResponses([summaryResponse]);

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary with bearer auth");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("uses the standalone compaction request context", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);

		const transformContext = vi.fn(async (messages: AgentMessage[]) => messages);
		harness.session.agent.transformContext = transformContext;
		harness.session.agent.sessionId = "active-routing-session";
		harness.session.agent.transport = "websocket";

		let requestContext: TranscriptContext | undefined;
		let requestOptions: SimpleStreamOptions | undefined;
		useSummaryStreamFn(harness, "standalone summary", (context, options) => {
			requestContext = context;
			requestOptions = options;
		});

		await harness.session.compact();

		expect(transformContext).not.toHaveBeenCalled();
		expect(getCurrentSystemPrompt(requestContext?.messages ?? [])).not.toBe(harness.session.agent.state.systemPrompt);
		expect(getCurrentTools(requestContext?.messages ?? [])).toEqual([]);
		// Regression test for #9652: split-turn summaries use a clear Markdown conversation boundary.
		expect(JSON.stringify(requestContext?.messages)).toContain("# Conversation\\n[User]: message to compact");
		expect(requestOptions).toMatchObject({ cacheRetention: "none" });
		expect(requestOptions?.sessionId).not.toBe("active-routing-session");
		expect(requestOptions?.transport).toBeUndefined();
	});

	it("persists usage from pi-generated manual compaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(result.usage).toEqual(createUsage(10));
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.type === "compaction" ? compactionEntries[0].usage : undefined).toEqual(
			createUsage(10),
		);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThan(0);
		expect(getStreamCallCount()).toBe(1);
	});

	it("notifies extensions when auto-compaction fails", async () => {
		const failedEvents: Array<{
			reason: "manual" | "threshold" | "overflow";
			errorMessage?: string;
			aborted: boolean;
			willRetry: boolean;
			fromExtension: boolean;
		}> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_compact_failed", async (event) => {
						failedEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.agent.streamFunction = () => {
			throw new Error("summary generator blew up");
		};
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
			errorMessage: "Auto-compaction failed: summary generator blew up",
		});
		expect(failedEvents).toEqual([
			expect.objectContaining({
				type: "session_compact_failed",
				reason: "threshold",
				aborted: false,
				willRetry: false,
				fromExtension: false,
				errorMessage: "Auto-compaction failed: summary generator blew up",
			}),
		]);
	});

	it("compacts and resumes after a length stop below the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("completed response"),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		expect(harness.session.getLastAssistantText()).toBe("completed response");
	});

	// Regression coverage for #8133: model overrides must also apply between assistant turns.
	// Regression coverage for #9740: an oversized trailing tool result must still produce a cut point.
	it.each([false, true])(
		"compacts after an oversized tool result in the same run (model override: %s)",
		async (modelOverride) => {
			const toolResult = `large-tool-result:${"x".repeat(8000)}`;
			const largeTool: AgentTool = {
				name: "large_result",
				label: "Large result",
				description: "Returns enough content to cross the compaction threshold",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: toolResult }], details: {} }),
			};
			const order: string[] = [];
			const observedSettings: unknown[] = [];
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
				settings: {
					compaction: modelOverride
						? {
								enabled: true,
								reserveTokens: 0,
								keepRecentTokens: 20000,
								modelOverrides: { "faux/faux-1": { reserveTokens: 400, keepRecentTokens: 1750 } },
							}
						: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 },
				},
				tools: [largeTool],
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							order.push("compaction");
							observedSettings.push(event.preparation.settings);
							return {
								compaction: {
									summary: "compacted history",
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
			let resumedRequest = "";
			harness.setResponses([
				fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
				fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
				fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
				(context) => {
					order.push("provider");
					resumedRequest = JSON.stringify(context.messages);
					return fauxAssistantMessage("finished after compaction");
				},
			]);

			await harness.session.prompt("seed old history");
			await harness.session.prompt("seed recent history");
			const agentStartsBefore = harness.eventsOfType("agent_start").length;
			await harness.session.prompt("run the large tool");

			expect(order.slice(0, 2)).toEqual(["compaction", "provider"]);
			expect(observedSettings[0]).toEqual({ enabled: true, reserveTokens: 400, keepRecentTokens: 1750 });
			// Compaction is stop-the-world: the run ends at the tool-batch boundary and a recovery run resumes it.
			expect(harness.eventsOfType("agent_start")).toHaveLength(agentStartsBefore + 2);
			expect(harness.eventsOfType("compaction_start").at(-1)).toEqual({
				type: "compaction_start",
				reason: "threshold",
			});
			expect(resumedRequest).toContain("compacted history");
			expect(resumedRequest).toContain("large-tool-result");
			expect(harness.session.getLastAssistantText()).toBe("finished after compaction");
		},
	);

	it("includes steering queued during compaction in the resumed assistant request", async () => {
		const largeTool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Returns enough content to cross the compaction threshold",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
				details: {},
			}),
		};
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [largeTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						markCompactionStarted();
						await compactionReleased;
						return {
							compaction: {
								summary: "compacted history",
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
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after compaction");
			},
			fauxAssistantMessage("finished after delayed steering"),
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		const promptPromise = harness.session.prompt("run the large tool");
		await compactionStarted;
		await harness.session.steer("change direction");
		releaseCompaction();
		await promptPromise;

		expect(resumedRequest).toContain("change direction");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("does not compact after a terminating tool result", async () => {
		const terminatingTool: AgentTool = {
			name: "terminate_with_large_result",
			label: "Terminate with large result",
			description: "Returns enough content to cross the compaction threshold, then terminates",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
				details: {},
				terminate: true,
			}),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [terminatingTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "unexpected compaction",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("terminate_with_large_result", {}), { stopReason: "toolUse" }),
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		await harness.session.prompt("run the terminating tool");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not compact when a length stop reaches the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(400), { stopReason: "length" })]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("stops after one compact-and-retry when a second response is also truncated", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("x".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
			() => fauxAssistantMessage("y".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start").filter((event) => event.reason === "overflow")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toBe(
			"Truncated response recovery failed after one compact-and-retry attempt.",
		);
	});

	it("keeps overflow wording when a repeated length stop fills the context window", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const lengthOverflowMessage = createAssistant(harness, {
			stopReason: "length",
			totalTokens: 100,
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(true);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(lengthOverflowMessage);
		await sessionInternals._checkCompaction({ ...lengthOverflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const { harness, compactionStarted } = await createAbortableCompactionHarness();
		harnesses.push(harness);

		const compactPromise = harness.session.compact();
		const compactExpectation = expect(compactPromise).rejects.toThrow("Compaction cancelled");
		await compactionStarted;
		harness.session.abortCompaction();

		await compactExpectation;
	});

	// Regression test for #8920.
	it("aborts an in-progress manual compaction and waits until the session is idle", async () => {
		const { harness, compactionStarted } = await createAbortableCompactionHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("continued")]);

		const compactPromise = harness.session.compact();
		const compactExpectation = expect(compactPromise).rejects.toThrow("Compaction cancelled");
		await compactionStarted;
		await harness.session.abort();
		await compactExpectation;

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "manual",
			aborted: true,
		});
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.session.isIdle).toBe(true);

		await expect(harness.session.prompt("next prompt")).resolves.toBeUndefined();
		expect(harness.session.getLastAssistantText()).toBe("continued");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(true);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "successful overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});

	it("keeps steering queued after failed compaction and releases it after the next success", async () => {
		let compactionAttempt = 0;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactionAttempt += 1;
						if (compactionAttempt === 1) return undefined;
						return {
							compaction: {
								summary: "recovered context",
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
		seedCompactableSession(harness);

		let markFirstCompactionStarted: () => void = () => undefined;
		const firstCompactionStarted = new Promise<void>((resolve) => {
			markFirstCompactionStarted = resolve;
		});
		let failFirstCompaction: (() => void) | undefined;
		const fauxStreamFn = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (model) => {
			const stream = createAssistantMessageEventStream();
			failFirstCompaction = () => {
				stream.push({
					type: "error",
					reason: "error",
					error: {
						...fauxAssistantMessage("", {
							stopReason: "error",
							errorMessage: "forced compaction failure",
						}),
						api: model.api,
						provider: model.provider,
						model: model.id,
					},
				});
			};
			markFirstCompactionStarted();
			return stream;
		};

		const failedCompaction = harness.session.compact();
		await firstCompactionStarted;
		await harness.session.steer("send after recovery");
		expect(harness.session.getSteeringMessages()).toEqual(["send after recovery"]);
		expect(failFirstCompaction).toBeTypeOf("function");
		failFirstCompaction?.();

		await expect(failedCompaction).rejects.toThrow("forced compaction failure");
		expect(harness.session.getSteeringMessages()).toEqual(["send after recovery"]);
		expect(harness.faux.state.callCount).toBe(0);

		let providerTexts: string[] = [];
		harness.session.agent.streamFunction = fauxStreamFn;
		harness.setResponses([
			(context) => {
				providerTexts = context.messages.flatMap((message) =>
					typeof message.content === "string"
						? [message.content]
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text),
				);
				return fauxAssistantMessage("steering delivered");
			},
		]);

		await expect(harness.session.compact()).resolves.toMatchObject({ summary: "recovered context" });
		await harness.session.waitForIdle();

		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(providerTexts.filter((text) => text === "send after recovery")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("resolves idle waiters after successful manual compaction without queued work", async () => {
		let finishCompaction: (() => void) | undefined;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise((resolve) => {
							finishCompaction = () =>
								resolve({
									compaction: {
										summary: "completed manual compaction",
										firstKeptEntryId: event.preparation.firstKeptEntryId,
										tokensBefore: event.preparation.tokensBefore,
										details: {},
									},
								});
						});
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const idlePromise = harness.session.waitForIdle();
		expect(finishCompaction).toBeTypeOf("function");
		finishCompaction?.();

		await expect(compactPromise).resolves.toMatchObject({ summary: "completed manual compaction" });
		await expect(idlePromise).resolves.toBeUndefined();
		expect(harness.session.isIdle).toBe(true);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
	});

	it("waits for active-run settlement before compacting and releasing queued steering", async () => {
		let markSettlementStarted: () => void = () => undefined;
		const settlementStarted = new Promise<void>((resolve) => {
			markSettlementStarted = resolve;
		});
		let releaseSettlement: () => void = () => undefined;
		const settlementReleased = new Promise<void>((resolve) => {
			releaseSettlement = resolve;
		});
		let firstSettlement = true;
		let compactionStarted = false;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						if (!firstSettlement) return;
						firstSettlement = false;
						markSettlementStarted();
						await settlementReleased;
					});
					pi.on("session_before_compact", async (event) => {
						compactionStarted = true;
						return {
							compaction: {
								summary: "settled recovery context",
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
		seedCompactableSession(harness);
		const publicLifecycle: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") {
				publicLifecycle.push(`agent_settled:${harness.session.isIdle}:${harness.session.isCompacting}`);
			} else if (event.type === "compaction_start") {
				publicLifecycle.push("compaction_start");
			}
		});

		let providerTexts: string[] = [];
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			(context) => {
				providerTexts = context.messages.flatMap((message) =>
					typeof message.content === "string"
						? [message.content]
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text),
				);
				return fauxAssistantMessage("recovered after settlement");
			},
		]);

		const initialPrompt = harness.session.prompt("initial turn");
		await settlementStarted;
		const compactPromise = harness.session.compact();
		await harness.session.steer("queued while settling");
		await Promise.resolve();

		expect(harness.session.isCompacting).toBe(false);
		expect(harness.session.isCompactionIngressBlocked).toBe(true);
		expect(harness.session.getSteeringMessages()).toEqual(["queued while settling"]);
		expect(compactionStarted).toBe(false);

		releaseSettlement();
		await initialPrompt;
		await expect(compactPromise).resolves.toMatchObject({ summary: "settled recovery context" });
		await harness.session.waitForIdle();

		expect(compactionStarted).toBe(true);
		expect(providerTexts.filter((text) => text === "queued while settling")).toHaveLength(1);
		expect(harness.session.pendingMessageCount).toBe(0);
		// The first settlement happens with a manual compaction already requested, so the
		// session is not idle: ingress is blocked and a send would be deferred.
		expect(publicLifecycle).toEqual(["agent_settled:false:false", "compaction_start", "agent_settled:true:false"]);
	});

	it("keeps the manual barrier active while aborting an in-flight agent run", async () => {
		const settledIdleStates: boolean[] = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", (_event, ctx) => {
						settledIdleStates.push(ctx.isIdle());
					});
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "manual active-run recovery",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		let streamCalls = 0;
		let providersInFlight = 0;
		let maxProvidersInFlight = 0;
		let recoveryTexts: string[] = [];
		harness.session.agent.streamFunction = (model, context, options) => {
			streamCalls += 1;
			providersInFlight += 1;
			maxProvidersInFlight = Math.max(maxProvidersInFlight, providersInFlight);
			const stream = createAssistantMessageEventStream();
			if (streamCalls === 1) {
				const finishAborted = () => {
					providersInFlight -= 1;
					stream.push({
						type: "error",
						reason: "aborted",
						error: {
							...fauxAssistantMessage("Aborted", { stopReason: "aborted" }),
							api: model.api,
							provider: model.provider,
							model: model.id,
						},
					});
				};
				if (options?.signal?.aborted) {
					queueMicrotask(finishAborted);
				} else {
					options?.signal?.addEventListener("abort", finishAborted, { once: true });
				}
				return stream;
			}

			recoveryTexts = context.messages.flatMap((message) =>
				typeof message.content === "string"
					? [message.content]
					: message.content
							.filter((part): part is { type: "text"; text: string } => part.type === "text")
							.map((part) => part.text),
			);
			queueMicrotask(() => {
				providersInFlight -= 1;
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("recovered"),
						api: model.api,
						provider: model.provider,
						model: model.id,
					},
				});
			});
			return stream;
		};

		const activePrompt = harness.session.prompt("active request");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.isStreaming).toBe(true);
		const compactPromise = harness.session.compact();
		expect(harness.session.isCompacting).toBe(true);
		await harness.session.prompt("queued during active manual compaction");

		await activePrompt;
		await expect(compactPromise).resolves.toMatchObject({ summary: "manual active-run recovery" });
		await harness.session.waitForIdle();

		expect(streamCalls).toBe(2);
		expect(maxProvidersInFlight).toBe(1);
		expect(recoveryTexts.filter((text) => text === "queued during active manual compaction")).toHaveLength(1);
		expect(recoveryTexts.some((text) => text.includes("manual active-run recovery"))).toBe(true);
		expect(settledIdleStates).toEqual([true]);
	});

	it("cancels in-progress manual compaction without replaying parked messages", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						pi.sendMessage(
							{ customType: "parked-on-cancel", content: "do not replay", display: false },
							{ triggerTurn: true, deliverAs: "steer" },
						);
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const idlePromise = harness.session.waitForIdle();
		await expect(harness.session.compact()).rejects.toThrow("Compaction is already in progress");
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
		await expect(idlePromise).resolves.toBeUndefined();
		expect(harness.session.pendingMessageCount).toBe(1);
		expect(harness.session.getSteeringMessages()).toEqual(["do not replay"]);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "parked-on-cancel"),
		).toHaveLength(0);
	});

	it("preserves explicit custom-message steering through auto-compaction", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						pi.sendMessage(
							{ customType: "compaction-steer", content: "steer after compaction", display: true },
							{ triggerTurn: true, deliverAs: "steer" },
						);
						return {
							compaction: {
								summary: "auto compacted",
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
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);

		const queued = harness.session.agent.drainQueuedMessages();
		expect(queued.steering).toEqual([expect.objectContaining({ role: "custom", customType: "compaction-steer" })]);
		expect(queued.followUp).toEqual([]);
	});

	it("delivers extension-injected triggerTurn steering into the turn after compaction completes", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						pi.sendMessage(
							{ customType: "compaction-steer", content: "steer after compaction", display: true },
							{ triggerTurn: true, deliverAs: "steer" },
						);
						return {
							compaction: {
								summary: "auto compacted",
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
		seedCompactableSession(harness);

		let providerTexts: string[] = [];
		harness.setResponses([
			(context) => {
				providerTexts = context.messages.map((message) => getMessageText(message));
				return fauxAssistantMessage("steering delivered");
			},
		]);

		await harness.session.compact();
		await harness.session.waitForIdle();

		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(providerTexts.filter((text) => text === "steer after compaction")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("delivers steering queued by a compaction-end handler into the retry turn", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow recovery completed",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		harness.session.subscribe((event) => {
			if (event.type !== "compaction_end") return;
			void harness.session.steer("steer after compaction");
		});

		let retryTexts: string[] = [];
		const responseTimestamp = Date.now() + 10_000;
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long",
				timestamp: responseTimestamp,
			}),
			(context) => {
				retryTexts = context.messages.map((message) => getMessageText(message));
				return fauxAssistantMessage("retried after compaction");
			},
		]);

		await harness.session.prompt("request");
		await harness.session.waitForIdle();

		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(retryTexts.filter((text) => text === "steer after compaction")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("recovers from overflow even when an extension rewrites the failed assistant message", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow recovery completed",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant" || event.message.stopReason !== "error") return;
						return {
							message: {
								...event.message,
								stopReason: "aborted" as const,
								errorMessage: "extension tried to mask overflow",
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		const responseTimestamp = Date.now() + 10_000;
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long",
				timestamp: responseTimestamp,
			}),
			fauxAssistantMessage("retried after compaction"),
		]);

		await harness.session.prompt("request");
		await harness.session.waitForIdle();

		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
		const overflowEntry = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.find((message) => message.role === "assistant" && message.errorMessage !== undefined);
		expect(overflowEntry).toMatchObject({ stopReason: "error", errorMessage: "prompt is too long" });
	});

	it("preserves default custom-message steering through auto-compaction", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						pi.sendMessage(
							{ customType: "compaction-trigger", content: "trigger after compaction", display: true },
							{ triggerTurn: true },
						);
						pi.sendMessage({
							customType: "compaction-default",
							content: "default after compaction",
							display: true,
						});
						return {
							compaction: {
								summary: "auto compacted",
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
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);

		const queued = harness.session.agent.drainQueuedMessages();
		expect(queued.steering).toEqual([
			expect.objectContaining({ role: "custom", customType: "compaction-trigger" }),
			expect.objectContaining({ role: "custom", customType: "compaction-default" }),
		]);
		expect(queued.followUp).toEqual([]);
	});

	it("recovers model-visible messages after failed auto-compaction through manual compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						if (event.reason === "threshold") {
							pi.sendMessage(
								{ customType: "remote-before-recovery", content: "remote before recovery", display: false },
								{ triggerTurn: true, deliverAs: "steer" },
							);
							return undefined;
						}
						pi.sendMessage(
							{ customType: "remote-during-manual", content: "remote during manual", display: false },
							{ triggerTurn: true, deliverAs: "steer" },
						);
						return {
							compaction: {
								summary: "manual recovery summary",
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
		seedCompactableSession(harness);
		harness.session.agent.steeringMode = "all";

		let providerTexts: string[] = [];
		const fauxStreamFn = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = () => {
			throw new Error("forced automatic compaction failure");
		};
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);
		expect(harness.session.pendingMessageCount).toBe(1);
		expect(harness.session.getSteeringMessages()).toEqual(["remote before recovery"]);
		expect(harness.faux.state.callCount).toBe(0);

		harness.session.agent.streamFunction = fauxStreamFn;
		harness.setResponses([
			(context) => {
				providerTexts = context.messages.flatMap((message) =>
					typeof message.content === "string"
						? [message.content]
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text),
				);
				return fauxAssistantMessage("recovered");
			},
		]);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start" && event.reason === "manual") {
				void harness.session.prompt("interactive during manual");
			}
		});
		await expect(harness.session.compact()).resolves.toMatchObject({ summary: "manual recovery summary" });
		await harness.session.waitForIdle();

		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.faux.state.callCount).toBe(1);
		for (const expected of ["remote before recovery", "remote during manual", "interactive during manual"]) {
			expect(providerTexts.filter((text) => text === expected)).toHaveLength(1);
		}
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("reports deferred default custom messages as steering when clearing the barrier queue", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		sessionInternals._enterCompactionBarrier("threshold", false);

		await harness.session.sendCustomMessage(
			{ customType: "compaction-trigger", content: "trigger after compaction", display: true },
			{ triggerTurn: true },
		);
		await harness.session.sendCustomMessage({
			customType: "compaction-default",
			content: "default after compaction",
			display: true,
		});

		expect(harness.session.clearQueue()).toEqual({
			steering: ["trigger after compaction", "default after compaction"],
			followUp: [],
			nextTurn: [],
		});
	});

	it("allows pre-prompt overflow recovery after an extension cancels compaction", async () => {
		let compactionAttempts = 0;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactionAttempts++;
						if (compactionAttempts === 1) {
							return { cancel: true as const };
						}
						return {
							compaction: {
								summary: "overflow recovery succeeded",
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
		seedCompactableSession(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("first request");
		const failedResponse = harness.session.messages.at(-1);
		expect(failedResponse).toMatchObject({ role: "assistant", stopReason: "error" });

		await harness.session.prompt("second request");

		expect(compactionAttempts).toBe(2);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(
			harness
				.eventsOfType("compaction_end")
				.some((event) => event.errorMessage?.includes("after one compact-and-retry attempt")),
		).toBe(false);
	});

	it("stops after a completed compact-and-retry overflows again", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow recovery completed",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const responseTimestamp = Date.now() + 10_000;
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long",
				timestamp: responseTimestamp,
			}),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long",
				timestamp: responseTimestamp + 1,
			}),
		]);

		await harness.session.prompt("request");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(
			harness
				.eventsOfType("compaction_end")
				.filter((event) => event.errorMessage?.includes("after one compact-and-retry attempt")),
		).toHaveLength(1);
	});

	it("bounds repeated recovery when one steering message is parked during compaction", async () => {
		let compactionAttempts = 0;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactionAttempts++;
						if (compactionAttempts === 1) {
							pi.sendUserMessage("steer during recovery", { deliverAs: "steer" });
						}
						return {
							compaction: {
								summary: `overflow recovery ${compactionAttempts}`,
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
		seedCompactableSession(harness);
		const responseTimestamp = Date.now() + 10_000;
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long",
				timestamp: responseTimestamp,
			}),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long",
				timestamp: responseTimestamp + 1,
			}),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long",
				timestamp: responseTimestamp + 2,
			}),
		]);

		await harness.session.prompt("request");

		expect(compactionAttempts).toBe(2);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(2);
		expect(
			harness
				.eventsOfType("compaction_end")
				.filter((event) => event.errorMessage?.includes("after one compact-and-retry attempt")),
		).toHaveLength(1);
	});

	it("stops after a completed length-stop compact-and-retry overflows again", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "length-stop overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const responses = [
			createAssistant(harness, {
				stopReason: "length",
				totalTokens: harness.getModel().contextWindow,
				timestamp: Date.now() + 10_000,
			}),
			createAssistant(harness, {
				stopReason: "length",
				totalTokens: harness.getModel().contextWindow,
				timestamp: Date.now() + 10_001,
			}),
		];
		let modelCalls = 0;
		harness.session.agent.streamFunction = (model) => {
			const stream = createAssistantMessageEventStream();
			const response = responses[modelCalls++];
			if (!response || (response.stopReason !== "length" && response.stopReason !== "stop")) {
				throw new Error("Expected a queued length or stop response");
			}
			const reason = response.stopReason;
			queueMicrotask(() => {
				const message = { ...response, api: model.api, provider: model.provider, model: model.id };
				stream.push({ type: "done", reason, message });
			});
			return stream;
		};

		await harness.session.prompt("request");

		expect(modelCalls).toBe(2);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(
			harness
				.eventsOfType("compaction_end")
				.filter((event) => event.errorMessage?.includes("after one compact-and-retry attempt")),
		).toHaveLength(1);
	});

	it("reports busy while a requested manual compaction is still deferring messages", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "pending window compaction",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		// compact() marks the session as pending and yields before raising the barrier.
		const compactPromise = harness.session.compact();
		expect(harness.session.isCompactionIngressBlocked).toBe(true);
		expect(harness.session.isIdle).toBe(false);

		await expect(compactPromise).resolves.toMatchObject({ summary: "pending window compaction" });
		expect(harness.session.isIdle).toBe(true);
	});

	it("runs ctx.onIdle() callbacks from an event handler only after the agent run settles", async () => {
		const order: string[] = [];
		let settledCallbackRan = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", (_event, ctx) => {
						ctx.onIdle(() => {
							order.push("idle");
						});
					});
					pi.on("agent_settled", (_event, ctx) => {
						order.push("settled");
						// Registering from a handler the run is waiting on is safe: the
						// callback runs after the handler returns and the run unwinds.
						ctx.onIdle(() => {
							settledCallbackRan = true;
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(order).toEqual(["settled", "idle"]);
		expect(settledCallbackRan).toBe(true);
	});

	it("runs one ctx.onIdle() callback when several events collapse onto one idle point", async () => {
		let continuations = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					// A stable reference, the way a Goal-style extension would hold one.
					const onIdleContinue = () => {
						continuations += 1;
					};
					pi.on("agent_start", (_event, ctx) => {
						ctx.onIdle(onIdleContinue);
					});
					pi.on("agent_end", (_event, ctx) => {
						ctx.onIdle(onIdleContinue);
					});
					pi.on("agent_settled", (_event, ctx) => {
						ctx.onIdle(onIdleContinue);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(continuations).toBe(1);
	});

	it("keeps ctx.onIdle() pending for an event handler until compaction finishes", async () => {
		let idleCallbackRan = false;
		let finishCompaction: (() => void) | undefined;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event, ctx) => {
						ctx.onIdle(() => {
							idleCallbackRan = true;
						});
						return await new Promise((resolve) => {
							finishCompaction = () =>
								resolve({
									compaction: {
										summary: "completed manual compaction",
										firstKeptEntryId: event.preparation.firstKeptEntryId,
										tokensBefore: event.preparation.tokensBefore,
										details: {},
									},
								});
						});
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(finishCompaction).toBeTypeOf("function");
		expect(idleCallbackRan).toBe(false);

		finishCompaction?.();
		await expect(compactPromise).resolves.toMatchObject({ summary: "completed manual compaction" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(idleCallbackRan).toBe(true);
	});
});
