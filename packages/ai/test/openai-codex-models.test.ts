import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";

describe("OpenAI Codex models", () => {
	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const)(
		"uses the 272k GPT-5.6 Codex default for %s",
		(modelId) => {
			expect(getModel("openai-codex", modelId).contextWindow).toBe(272000);
		},
	);
});
