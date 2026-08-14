import type { Api, Model, Provider } from "@earendil-works/pi-ai";

const PRESERVED_OPENAI_CODEX_CONTEXT_MODELS = new Set(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);

/** Reapply intentional Fractal catalog metadata after generic remote overlays. */
export function withFractalModelCatalogOverrides(builtin: Provider, effective: Provider): Provider {
	if (builtin.id !== "openai-codex") return effective;

	const contextWindows = new Map(
		builtin
			.getModels()
			.filter((model) => PRESERVED_OPENAI_CODEX_CONTEXT_MODELS.has(model.id))
			.map((model) => [model.id, model.contextWindow]),
	);
	return {
		...effective,
		getModels: (): readonly Model<Api>[] =>
			effective.getModels().map((model) => {
				const contextWindow = contextWindows.get(model.id);
				return contextWindow === undefined || model.contextWindow === contextWindow
					? model
					: { ...model, contextWindow };
			}),
	};
}
