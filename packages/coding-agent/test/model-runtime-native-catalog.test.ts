import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { allowNetwork } from "./test-network-env.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

it("uses the provider's native discovery instead of replacing it with pi.dev, and preserves user overrides", async () => {
	allowNetwork();
	const root = await mkdtemp(join(tmpdir(), "pi-native-catalog-"));
	const modelsPath = join(root, "models.json");
	const modelId = "unbundled-codex-fixture";
	const configured = JSON.stringify({
		providers: { "openai-codex": { modelOverrides: { [modelId]: { contextWindow: 64_000 } } } },
	});
	await writeFile(modelsPath, configured);
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai-codex", async () => ({
		type: "oauth",
		access: "fixture",
		refresh: "fixture",
		accountId: "fixture-account",
		expires: Date.now() + 60_000,
	}));
	const modelsStore = new InMemoryModelsStore();
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (url) => {
			if (String(url).includes("registry.npmjs.org")) return Response.json({ version: "0.999.2" });
			if (String(url).includes("chatgpt.com/backend-api/codex/models"))
				return Response.json({
					models: [
						{
							slug: modelId,
							display_name: "Native fixture",
							visibility: "list",
							context_window: 272_000,
							max_context_window: 872_000,
							supported_reasoning_levels: [{ effort: "high" }],
							input_modalities: ["text", "image"],
						},
					],
				});
			if (String(url).includes("pi.dev/api/models/providers/openai-codex"))
				return Response.json({ [modelId]: { ...getBuiltinModel("openai-codex", "gpt-5.5"), id: modelId } });
			throw new Error("Unexpected catalog request");
		}),
	);
	try {
		const runtime = await ModelRuntime.create({ credentials, modelsStore, modelsPath, allowModelNetwork: false });
		expect(runtime.getModel("openai-codex", modelId)).toBeUndefined();
		const result = await runtime.refresh({ allowNetwork: true });
		expect([...result.errors.values()]).toEqual([]);
		expect(runtime.getAvailableSnapshot().find((model) => model.id === modelId)).toMatchObject({
			contextWindow: 64_000,
			maxContextWindow: 872_000,
		});
		expect(await readFile(modelsPath, "utf8")).toBe(configured);
		vi.stubGlobal("fetch", async () => {
			throw new Error("Offline startup must not fetch");
		});
		const restarted = await ModelRuntime.create({ credentials, modelsStore, modelsPath, allowModelNetwork: false });
		expect(restarted.getAvailableSnapshot().find((model) => model.id === modelId)).toMatchObject({
			contextWindow: 64_000,
			maxContextWindow: 872_000,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
