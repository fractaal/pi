import type { Context, Model, ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";
import type { OpenAICodexNativeCompactionResult, OpenAICodexSimpleStreamOptions } from "./openai-codex-responses.ts";

const loadOpenAICodexResponses = () => import("./openai-codex-responses.ts");

export const openAICodexResponsesApi = (): ProviderStreams => lazyApi(loadOpenAICodexResponses);

export async function compactOpenAICodexResponsesLazy(
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexSimpleStreamOptions,
): Promise<OpenAICodexNativeCompactionResult> {
	return (await loadOpenAICodexResponses()).compactOpenAICodexResponses(model, context, options);
}
