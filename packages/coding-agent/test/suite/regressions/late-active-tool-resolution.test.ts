import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../../../src/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

type Exposure = "direct" | "deferred" | "codemode" | "hidden";

function toolNames(context: TranscriptContext): string[] {
	return getCurrentTools(context.messages)
		.map((tool) => tool.name)
		.sort();
}

function toolResults(harness: Harness): ToolResultMessage[] {
	return harness.session.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

/** Register `late_tool` with the given exposure; it is not active when the turn starts. */
function registerLateTool(exposure: Exposure, executed: string[]): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "late_tool",
			label: "Late tool",
			description: "A tool that is not active when the turn starts",
			parameters: Type.Object({ value: Type.String() }),
			exposure,
			defaultActive: false,
			execute: async (_id, params) => {
				executed.push(params.value);
				return { content: [{ type: "text", text: "late ran" }], details: {} };
			},
		});
	};
}

describe("calls to tools that become available during a turn", () => {
	it("runs a tool that was activated after the turn started", async () => {
		const executed: string[] = [];
		const harness = await createHarness({ extensionFactories: [registerLateTool("direct", executed)] });
		try {
			harness.setResponses([
				() => {
					// An extension or bridge activates the tool while the model is answering.
					harness.session.setActiveToolsByName(["late_tool"]);
					return fauxAssistantMessage(fauxToolCall("late_tool", { value: "a" }), { stopReason: "toolUse" });
				},
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("start");

			expect(executed).toEqual(["a"]);
			expect(toolResults(harness).map((result) => result.isError)).toEqual([false]);
		} finally {
			harness.cleanup();
		}
	});

	it.each(["deferred", "codemode"] as const)(
		"runs a registered unloaded %s tool and declares it from the next request",
		async (exposure) => {
			const executed: string[] = [];
			const requests: string[][] = [];
			const harness = await createHarness({ extensionFactories: [registerLateTool(exposure, executed)] });
			try {
				harness.setResponses([
					(context) => {
						requests.push(toolNames(context));
						return fauxAssistantMessage(fauxToolCall("late_tool", { value: "b" }), { stopReason: "toolUse" });
					},
					(context) => {
						requests.push(toolNames(context));
						return fauxAssistantMessage("done");
					},
				]);
				expect(harness.session.getActiveToolNames()).not.toContain("late_tool");

				await harness.session.prompt("start");

				expect(executed).toEqual(["b"]);
				expect(toolResults(harness).map((result) => result.isError)).toEqual([false]);
				expect(requests[0]).not.toContain("late_tool");
				expect(requests[1]).toContain("late_tool");
				expect(harness.session.getActiveToolNames()).toContain("late_tool");
			} finally {
				harness.cleanup();
			}
		},
	);

	it.each([
		{ name: "hidden", exposure: "hidden" as const, call: "late_tool" },
		{ name: "inactive direct", exposure: "direct" as const, call: "late_tool" },
		{ name: "unknown", exposure: "direct" as const, call: "no_such_tool" },
	])("still reports a $name tool as not found", async ({ exposure, call }) => {
		const executed: string[] = [];
		const harness = await createHarness({ extensionFactories: [registerLateTool(exposure, executed)] });
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall(call, { value: "c" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("start");

			expect(executed).toEqual([]);
			const [result] = toolResults(harness);
			expect(result?.isError).toBe(true);
			expect(getMessageText(result!)).toContain(`Tool ${call} not found`);
			expect(harness.session.getActiveToolNames()).not.toContain(call);
		} finally {
			harness.cleanup();
		}
	});

	it("still validates arguments of a resolved tool", async () => {
		const executed: string[] = [];
		const harness = await createHarness({ extensionFactories: [registerLateTool("deferred", executed)] });
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("late_tool", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("start");

			expect(executed).toEqual([]);
			expect(toolResults(harness).map((result) => result.isError)).toEqual([true]);
		} finally {
			harness.cleanup();
		}
	});

	it("still lets a tool_call hook block a resolved tool", async () => {
		const executed: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				registerLateTool("deferred", executed),
				(pi) => {
					pi.on("tool_call", (event) =>
						event.toolName === "late_tool" ? { block: true, reason: "blocked by policy" } : undefined,
					);
				},
			],
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("late_tool", { value: "d" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("start");

			expect(executed).toEqual([]);
			const [result] = toolResults(harness);
			expect(result?.isError).toBe(true);
			expect(getMessageText(result!)).toContain("blocked by policy");
		} finally {
			harness.cleanup();
		}
	});
});
