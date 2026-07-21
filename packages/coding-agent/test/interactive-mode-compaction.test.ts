import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

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

	test("routes interactive input through the AgentSession compaction barrier", async () => {
		const fakeThis = {
			session: {
				isCompactionIngressBlocked: true,
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			compactionQueuedMessages: [],
			editor: { addToHistory: vi.fn(), setText: vi.fn() },
			updatePendingMessagesDisplay: vi.fn(),
			showStatus: vi.fn(),
		};
		const queueCompactionMessage = Reflect.get(InteractiveMode.prototype, "queueCompactionMessage") as (
			this: typeof fakeThis,
			text: string,
			mode: "steer" | "followUp",
		) => Promise<void>;

		await queueCompactionMessage.call(fakeThis, "queued steer", "steer");
		await queueCompactionMessage.call(fakeThis, "queued follow-up", "followUp");

		expect(fakeThis.session.steer).toHaveBeenCalledWith("queued steer");
		expect(fakeThis.session.followUp).toHaveBeenCalledWith("queued follow-up");
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
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
});
