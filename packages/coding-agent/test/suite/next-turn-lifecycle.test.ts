import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const checkpoint = (label: string) => ({ customType: "checkpoint", content: `checkpoint:${label}`, display: false });

describe("AgentSession next-turn lifecycle ownership", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("counts, reports, and clears pending next-turn messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.sendCustomMessage(checkpoint("pending"), { deliverAs: "nextTurn" });

		expect(harness.session.pendingMessageCount).toBe(1);
		expect(harness.session.clearQueue()).toEqual({
			steering: [],
			followUp: [],
			nextTurn: ["checkpoint:pending"],
		});
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("reload drops stale next-turn messages before restored extensions publish current state", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (event) => {
						pi.sendMessage(checkpoint(event.reason), { deliverAs: "nextTurn" });
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		expect(harness.session.pendingMessageCount).toBe(1);

		await harness.session.reload();

		expect(harness.session.pendingMessageCount).toBe(1);
		expect(harness.session.clearQueue().nextTurn).toEqual(["checkpoint:reload"]);
	});

	it("tree navigation replaces old-branch next-turn messages instead of accumulating them", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.sendMessage(checkpoint("startup"), { deliverAs: "nextTurn" });
					});
					pi.on("session_tree", () => {
						pi.sendMessage(checkpoint("tree"), { deliverAs: "nextTurn" });
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const userId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "branch" }],
			timestamp: Date.now(),
		});
		const assistantId = harness.sessionManager.appendMessage(fauxAssistantMessage("done"));
		expect(harness.session.pendingMessageCount).toBe(1);

		await harness.session.navigateTree(userId, { summarize: false });
		expect(harness.session.pendingMessageCount).toBe(1);
		await harness.session.navigateTree(assistantId, { summarize: false });
		expect(harness.session.pendingMessageCount).toBe(1);
		expect(harness.session.clearQueue().nextTurn).toEqual(["checkpoint:tree"]);
	});
});
