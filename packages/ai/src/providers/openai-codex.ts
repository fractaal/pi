import { compactOpenAICodexResponsesLazy, openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.ts";
import type { OpenAICodexProvider } from "../api/openai-codex-responses.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAICodexOAuth } from "../auth/oauth/load.ts";
import { createProvider } from "../models.ts";
import { OPENAI_CODEX_MODELS } from "./openai-codex.models.ts";

export type { OpenAICodexProvider } from "../api/openai-codex-responses.ts";
export {
	isOpenAICodexReauthenticationRequired,
	OpenAICodexOAuthRefreshError,
	type OpenAICodexOAuthRefreshErrorCode,
} from "../auth/oauth/openai-codex-errors.ts";

export function openaiCodexProvider(): OpenAICodexProvider {
	return {
		...createProvider({
			id: "openai-codex",
			name: "OpenAI Codex",
			baseUrl: "https://chatgpt.com/backend-api",
			auth: {
				oauth: lazyOAuth({ name: "OpenAI (ChatGPT Plus/Pro)", load: loadOpenAICodexOAuth }),
			},
			models: Object.values(OPENAI_CODEX_MODELS),
			api: openAICodexResponsesApi(),
		}),
		compactOpenAICodexResponses: compactOpenAICodexResponsesLazy,
	};
}
