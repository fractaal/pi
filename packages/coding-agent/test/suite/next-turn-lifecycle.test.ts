import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import type { ExtensionFactory, ResourceLoader } from "../../src/index.ts";
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
		const eventBus = createEventBus();
		const factory: ExtensionFactory = (pi) => {
			pi.on("session_start", (event) => {
				pi.sendMessage(checkpoint(event.reason), { deliverAs: "nextTurn" });
			});
		};
		// A reload re-instantiates extensions, so the restored extension publishes through a fresh API.
		const loadExtensions = async () => {
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime);
			return { extensions: [extension], errors: [], runtime };
		};
		let extensionsResult = await loadExtensions();
		const resourceLoader: ResourceLoader = {
			getExtensions: () => extensionsResult,
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {
				extensionsResult = await loadExtensions();
			},
		};
		const harness = await createHarness({ resourceLoader });
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
