import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";

describe("OpenAI Codex models", () => {
	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] as const)(
		"uses the 272k Codex default for %s",
		(modelId) => {
			expect(getModel("openai-codex", modelId).contextWindow).toBe(272000);
		},
	);

	it.each([
		["gpt-6-sol", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
		["gpt-6-luna", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
	] as const)("registers %s with the released pricing and reasoning efforts", (modelId, cost) => {
		const model = getModel("openai-codex", modelId);
		expect(model.cost).toMatchObject(cost);
		expect(model.thinkingLevelMap).toMatchObject({
			off: "none",
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});
});
