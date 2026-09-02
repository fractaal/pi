export type OpenAICodexOAuthRefreshErrorCode = "reauth_required" | "transient" | "invalid_response" | "aborted";

export class OpenAICodexOAuthRefreshError extends Error {
	readonly code: OpenAICodexOAuthRefreshErrorCode;
	readonly status?: number;

	constructor(code: OpenAICodexOAuthRefreshErrorCode, message: string, status?: number) {
		super(message);
		this.name = "OpenAICodexOAuthRefreshError";
		this.code = code;
		this.status = status;
	}
}

export function isOpenAICodexReauthenticationRequired(error: unknown): boolean {
	return error instanceof OpenAICodexOAuthRefreshError && error.code === "reauth_required";
}
