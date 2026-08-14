import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { getBuiltinModel, getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const GPT_56_MODELS = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const;

describe("Fractal model catalog overrides", () => {
	it("keeps GPT-5.6 Codex at 372k after a newer generic catalog overlay", async () => {
		const modelsStore = new InMemoryModelsStore();
		const generatedAt = getBuiltinModelDataGeneratedAt() ?? 0;
		await modelsStore.write("openai-codex", {
			models: [
				...GPT_56_MODELS.map((id) => ({
					...getBuiltinModel("openai-codex", id),
					name: `Remote ${id}`,
					contextWindow: 272000,
				})),
				{
					...getBuiltinModel("openai-codex", "gpt-5.5"),
					name: "Remote GPT-5.5",
					contextWindow: 300000,
				},
			],
			checkedAt: generatedAt + 60_000,
			lastModified: generatedAt + 60_000,
		});
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				"openai-codex": {
					type: "oauth",
					access: "test-access",
					refresh: "test-refresh",
					expires: Date.now() + 60_000,
				},
			}),
			modelsStore,
			modelsPath: null,
			allowModelNetwork: false,
		});

		for (const id of GPT_56_MODELS) {
			expect(runtime.getModel("openai-codex", id)).toMatchObject({
				name: `Remote ${id}`,
				contextWindow: 372000,
			});
		}
		expect(runtime.getModel("openai-codex", "gpt-5.5")).toMatchObject({
			name: "Remote GPT-5.5",
			contextWindow: 300000,
		});
	});
});
