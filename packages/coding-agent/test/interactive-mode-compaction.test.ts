import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness } from "./suite/harness.ts";

describe("InteractiveMode compaction events", () => {
	test("rebuilds chat and appends a synthetic compaction summary at the bottom", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
	});

	test("delivers interactive steering exactly once after automatic compaction", async () => {
		let markCompactionStarted: () => void = () => undefined;
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let finishCompaction: (() => void) | undefined;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 20_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise((resolve) => {
							finishCompaction = () =>
								resolve({
									compaction: {
										summary: "automatic compaction summary",
										firstKeptEntryId: event.preparation.firstKeptEntryId,
										tokensBefore: event.preparation.tokensBefore,
										details: {},
									},
								});
							markCompactionStarted();
						});
					});
				},
			],
		});
		const model = harness.getModel();
		const oldTimestamp = Date.now() - 10_000;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "older context" }],
			timestamp: oldTimestamp,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("older answer", { timestamp: oldTimestamp + 1 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		let providerTexts: string[] = [];
		let providerCalls = 0;
		harness.session.agent.streamFunction = (streamModel, context) => {
			providerCalls += 1;
			const stream = createAssistantMessageEventStream();
			if (providerCalls === 2) {
				providerTexts = context.messages.flatMap((message) =>
					typeof message.content === "string"
						? [message.content]
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text),
				);
			}
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage(providerCalls === 1 ? "before compaction" : "after compaction"),
						api: streamModel.api,
						provider: streamModel.provider,
						model: streamModel.id,
						usage:
							providerCalls === 1
								? {
										input: 190_000,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 190_000,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									}
								: {
										input: 100,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 100,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									},
					},
				});
			});
			return stream;
		};

		const fakeThis = {
			session: harness.session,
			compactionQueuedMessages: [],
			editor: { addToHistory: vi.fn(), setText: vi.fn() },
			updatePendingMessagesDisplay: vi.fn(),
			showStatus: vi.fn(),
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			clearStatusIndicator: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const queueCompactionMessage = Reflect.get(InteractiveMode.prototype, "queueCompactionMessage") as (
			this: typeof fakeThis,
			text: string,
			mode: "steer" | "followUp",
		) => Promise<void>;
		const getAllQueuedMessages = Reflect.get(InteractiveMode.prototype, "getAllQueuedMessages") as (
			this: typeof fakeThis,
		) => { steering: string[]; followUp: string[] };
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;
		const interactiveEvents: Promise<void>[] = [];
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "compaction_end") {
				interactiveEvents.push(handleEvent.call(fakeThis, event));
			}
		});

		try {
			const initialPrompt = harness.session.prompt("initial request");
			const unexpectedPrompt = vi.spyOn(harness.session, "prompt");
			await Promise.race([
				compactionStarted,
				initialPrompt.then(() => {
					throw new Error("Automatic compaction did not start");
				}),
			]);
			await queueCompactionMessage.call(fakeThis, "queued during compaction", "steer");
			expect(getAllQueuedMessages.call(fakeThis)).toEqual({
				steering: ["queued during compaction"],
				followUp: [],
			});
			expect(finishCompaction).toBeTypeOf("function");
			finishCompaction?.();

			await initialPrompt;
			await Promise.all(interactiveEvents);
			await Promise.resolve();

			expect(providerTexts.filter((text) => text === "queued during compaction")).toHaveLength(1);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(unexpectedPrompt).not.toHaveBeenCalled();
			expect(fakeThis.showError).not.toHaveBeenCalled();
		} finally {
			unsubscribe();
			harness.cleanup();
		}
	});

	test("surfaces and dequeues messages parked by AgentSession", () => {
		const fakeThis = {
			session: {
				getSteeringMessages: () => ["parked steer"],
				getFollowUpMessages: () => ["parked follow-up"],
				clearQueue: vi.fn(() => ({ steering: ["parked steer"], followUp: ["parked follow-up"] })),
			},
			compactionQueuedMessages: [{ text: "branch-summary queue", mode: "followUp" as const }],
		};
		const getAllQueuedMessages = Reflect.get(InteractiveMode.prototype, "getAllQueuedMessages") as (
			this: typeof fakeThis,
		) => { steering: string[]; followUp: string[] };
		const clearAllQueues = Reflect.get(InteractiveMode.prototype, "clearAllQueues") as (this: typeof fakeThis) => {
			steering: string[];
			followUp: string[];
		};

		expect(getAllQueuedMessages.call(fakeThis)).toEqual({
			steering: ["parked steer"],
			followUp: ["parked follow-up", "branch-summary queue"],
		});
		expect(clearAllQueues.call(fakeThis)).toEqual({
			steering: ["parked steer"],
			followUp: ["parked follow-up", "branch-summary queue"],
		});
		expect(fakeThis.session.clearQueue).toHaveBeenCalledTimes(1);
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
	});

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			compactionQueuedMessages: [{ text: "change direction", mode: "steer" as const }],
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("change direction", { streamingBehavior: "steer" });
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
