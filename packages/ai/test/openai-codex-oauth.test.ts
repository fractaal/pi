import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import {
	isOpenAICodexReauthenticationRequired,
	OpenAICodexOAuthRefreshError,
} from "../src/auth/oauth/openai-codex-errors.ts";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function createAccessToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": {
				chatgpt_account_id: accountId,
			},
		}),
	).toString("base64");
	return `${header}.${payload}.signature`;
}

function deviceAuthPendingResponse(): Response {
	return jsonResponse(
		{
			error: {
				message: "Device authorization is pending. Please try again.",
				type: "invalid_request_error",
				param: null,
				code: "deviceauth_authorization_pending",
			},
		},
		403,
	);
}

function loginOpenAICodexDeviceCodeForTest(options: {
	onDeviceCode(info: {
		userCode: string;
		verificationUri: string;
		intervalSeconds?: number;
		expiresInSeconds?: number;
	}): void;
	signal?: AbortSignal;
}) {
	return openaiCodexOAuth.login({
		signal: options.signal,
		prompt: async (prompt) => {
			if (prompt.type !== "select") throw new Error(`Unexpected prompt: ${prompt.type}`);
			return "device_code";
		},
		notify: (event) => {
			if (event.type === "device_code") {
				const { type: _, ...info } = event;
				options.onDeviceCode(info);
			}
		},
	});
}

describe("OpenAI Codex OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("releases the loopback callback port when an abandoned browser login is aborted", async () => {
		const listenable = async (): Promise<boolean> => {
			const net = await import("node:net");
			return await new Promise((resolve) => {
				const probe = net.createServer();
				probe.once("error", () => resolve(false));
				probe.once("listening", () => probe.close(() => resolve(true)));
				probe.listen(1455, "127.0.0.1");
			});
		};

		// A stale listener would make the rest of this vacuous.
		await vi.waitFor(async () => expect(await listenable()).toBe(true));

		const controller = new AbortController();
		let browserOpened = false;
		// The caller abandons the login without answering — a renderer reload or
		// profile switch, which is exactly when Desktop aborts. The login promise
		// stays pending on the manual-code prompt, so the port can only be freed by
		// the abort listener, not by the flow's own `finally`.
		const login = openaiCodexOAuth.login({
			signal: controller.signal,
			prompt: (prompt) => {
				if (prompt.type === "select") return Promise.resolve("browser");
				return new Promise<string>(() => {});
			},
			notify: (event) => {
				if (event.type === "auth_url") browserOpened = true;
			},
		});
		login.catch(() => undefined);

		await vi.waitFor(() => expect(browserOpened).toBe(true));
		expect(await listenable()).toBe(false);

		controller.abort();

		// Without abort wiring the callback server keeps port 1455 forever and the
		// next sign-in cannot bind.
		await vi.waitFor(async () => expect(await listenable()).toBe(true));
	});

	it("logs in with the OpenAI Codex device code flow", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-05-20T00:00:00Z");
		vi.setSystemTime(startTime);

		const accessToken = createAccessToken("account-123");
		const deviceInfos: Array<{
			userCode: string;
			verificationUri: string;
			instructions?: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
		}> = [];
		const pollTimes: number[] = [];
		const pollResponses = [
			deviceAuthPendingResponse(),
			jsonResponse({
				authorization_code: "oauth-code",
				code_challenge: "device-code-challenge",
				code_verifier: "device-code-verifier",
			}),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
				expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
				return jsonResponse({
					device_auth_id: "device-auth-id",
					user_code: "ABCD-1234",
					interval: "5",
				});
			}

			if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
				pollTimes.push(Date.now());
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
				expect(JSON.parse(String(init?.body))).toEqual({
					device_auth_id: "device-auth-id",
					user_code: "ABCD-1234",
				});
				const response = pollResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra device auth poll");
				}
				return response;
			}

			if (url === "https://auth.openai.com/oauth/token") {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("authorization_code");
				expect(params.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
				expect(params.get("code")).toBe("oauth-code");
				expect(params.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
				expect(params.get("code_verifier")).toBe("device-code-verifier");
				return jsonResponse({
					access_token: accessToken,
					refresh_token: "refresh-token",
					expires_in: 3600,
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const credentialsPromise = loginOpenAICodexDeviceCodeForTest({
			onDeviceCode: (info) => deviceInfos.push(info),
		});

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(deviceInfos).toEqual([
			{
				userCode: "ABCD-1234",
				verificationUri: "https://auth.openai.com/codex/device",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
		expect(pollTimes).toEqual([startTime.getTime()]);

		await vi.advanceTimersByTimeAsync(4999);
		expect(pollTimes).toEqual([startTime.getTime()]);

		await vi.advanceTimersByTimeAsync(1);
		await expect(credentialsPromise).resolves.toMatchObject({
			access: accessToken,
			refresh: "refresh-token",
			expires: startTime.getTime() + 5000 + 3600 * 1000,
			accountId: "account-123",
		});
		expect(pollTimes).toEqual([startTime.getTime(), startTime.getTime() + 5000]);
	});

	it("offers browser login first and uses the selected OpenAI Codex device code flow", async () => {
		const accessToken = createAccessToken("account-456");
		const selectPrompts: Array<{
			message: string;
			options: readonly { id: string; label: string }[];
		}> = [];
		const deviceInfos: Array<{
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
		}> = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "WXYZ-7890",
						interval: "5",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					return jsonResponse({
						authorization_code: "oauth-code",
						code_challenge: "device-code-challenge",
						code_verifier: "device-code-verifier",
					});
				}
				if (url === "https://auth.openai.com/oauth/token") {
					return jsonResponse({
						access_token: accessToken,
						refresh_token: "refresh-token",
						expires_in: 3600,
					});
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		await expect(
			openaiCodexOAuth.login({
				prompt: async (prompt) => {
					if (prompt.type !== "select") throw new Error("Text prompt should not be used");
					selectPrompts.push(prompt);
					return "device_code";
				},
				notify: (event) => {
					if (event.type === "auth_url") throw new Error("Browser login should not start");
					if (event.type === "device_code") {
						const { type: _, ...info } = event;
						deviceInfos.push(info);
					}
				},
			}),
		).resolves.toMatchObject({
			type: "oauth",
			access: accessToken,
			refresh: "refresh-token",
			accountId: "account-456",
		});

		expect(selectPrompts).toEqual([
			{
				type: "select",
				message: "Select OpenAI Codex login method:",
				options: [
					{ id: "browser", label: "Browser login (default)" },
					{ id: "device_code", label: "Device code login (headless)" },
				],
			},
		]);
		expect(deviceInfos).toEqual([
			{
				userCode: "WXYZ-7890",
				verificationUri: "https://auth.openai.com/codex/device",
				intervalSeconds: 5,
				expiresInSeconds: 900,
			},
		]);
	});

	it("cancels when OpenAI Codex login method selection is cancelled", async () => {
		await expect(
			openaiCodexOAuth.login({
				prompt: async () => {
					throw new Error("Login cancelled");
				},
				notify: () => {},
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("cancels the OpenAI Codex device code flow while waiting", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const pollTimes: number[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "5",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					pollTimes.push(Date.now());
					return deviceAuthPendingResponse();
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialsPromise = loginOpenAICodexDeviceCodeForTest({
			onDeviceCode: () => {},
			signal: controller.signal,
		});
		const rejectionPromise = credentialsPromise.then(
			() => new Error("Expected login to fail"),
			(error: unknown) => error,
		);

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(pollTimes).toHaveLength(1);

		controller.abort();
		const rejection = await rejectionPromise;
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toBe("Login cancelled");
	});

	it("times out the OpenAI Codex device code flow after 15 minutes", async () => {
		vi.useFakeTimers();
		const pollTimes: number[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "60",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					pollTimes.push(Date.now());
					return deviceAuthPendingResponse();
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialsPromise = loginOpenAICodexDeviceCodeForTest({
			onDeviceCode: () => {},
		});
		const rejectionPromise = credentialsPromise.then(
			() => new Error("Expected login to fail"),
			(error: unknown) => error,
		);

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(pollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
		const rejection = await rejectionPromise;
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toBe("Device flow timed out");
	});

	it("treats OpenAI Codex device auth 403 and 404 responses as pending", async () => {
		vi.useFakeTimers();
		const accessToken = createAccessToken("account-403-404");
		const pollTimes: number[] = [];
		const pollResponses = [
			jsonResponse({ error: "access_denied", error_description: "denied" }, 403),
			new Response("not ready", { status: 404, headers: { "Content-Type": "text/plain" } }),
			jsonResponse({
				authorization_code: "oauth-code",
				code_challenge: "device-code-challenge",
				code_verifier: "device-code-verifier",
			}),
		];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "1",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					pollTimes.push(Date.now());
					const response = pollResponses.shift();
					if (!response) {
						throw new Error("Unexpected extra device auth poll");
					}
					return response;
				}
				if (url === "https://auth.openai.com/oauth/token") {
					return jsonResponse({
						access_token: accessToken,
						refresh_token: "refresh-token",
						expires_in: 3600,
					});
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialsPromise = loginOpenAICodexDeviceCodeForTest({
			onDeviceCode: () => {},
		});

		for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);

		await expect(credentialsPromise).resolves.toMatchObject({
			access: accessToken,
			refresh: "refresh-token",
			accountId: "account-403-404",
		});
		expect(pollTimes).toHaveLength(3);
	});

	it("includes the response body in OpenAI Codex device auth poll failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
					return jsonResponse({
						device_auth_id: "device-auth-id",
						user_code: "ABCD-1234",
						interval: "5",
					});
				}
				if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
					return jsonResponse({ error: "server_error", error_description: "try again later" }, 500);
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		await expect(
			loginOpenAICodexDeviceCodeForTest({
				onDeviceCode: () => {},
			}),
		).rejects.toThrow(
			'OpenAI Codex device auth failed with status 500: {"error":"server_error","error_description":"try again later"}',
		);
	});

	it.each([
		[401, { error: { type: "invalid_request_error" } }],
		[403, { error: { type: "forbidden" } }],
		[400, { error: "invalid_grant" }],
	] as const)("classifies HTTP %i credential rejection as requiring reauthentication", async (status, body) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(body, status)),
		);

		const error = await openaiCodexOAuth
			.refresh({
				type: "oauth",
				access: "invalid-access-token",
				refresh: "invalid-refresh-token",
				expires: 0,
			})
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(OpenAICodexOAuthRefreshError);
		expect(error).toMatchObject({ code: "reauth_required", status });
		expect(isOpenAICodexReauthenticationRequired(error)).toBe(true);
		expect(String(error)).not.toContain("invalid-refresh-token");
	});

	it.each([429, 500, 503])("classifies HTTP %i refresh failures as transient", async (status) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "server_error" }, status)),
		);

		const error = await openaiCodexOAuth
			.refresh({ type: "oauth", access: "access", refresh: "refresh", expires: 0 })
			.catch((reason: unknown) => reason);

		expect(error).toMatchObject({ code: "transient", status });
		expect(isOpenAICodexReauthenticationRequired(error)).toBe(false);
	});

	it("classifies network refresh failures as transient", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("network unavailable"))),
		);

		const error = await openaiCodexOAuth
			.refresh({ type: "oauth", access: "access", refresh: "refresh", expires: 0 })
			.catch((reason: unknown) => reason);

		expect(error).toMatchObject({ code: "transient" });
		expect(isOpenAICodexReauthenticationRequired(error)).toBe(false);
	});

	it("classifies malformed successful refresh responses without exposing token fields", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ access_token: "sensitive-access-token", expires_in: 3600 })),
		);

		const error = await openaiCodexOAuth
			.refresh({ type: "oauth", access: "access", refresh: "refresh", expires: 0 })
			.catch((reason: unknown) => reason);

		expect(error).toMatchObject({ code: "invalid_response" });
		expect(String(error)).not.toContain("sensitive-access-token");
		expect(isOpenAICodexReauthenticationRequired(error)).toBe(false);
	});

	it("passes cancellation to refresh fetch and classifies it separately", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			expect(init?.signal).toBe(controller.signal);
			throw new Error("aborted transport");
		});
		vi.stubGlobal("fetch", fetchMock);

		const error = await openaiCodexOAuth
			.refresh({ type: "oauth", access: "access", refresh: "refresh", expires: 0 }, controller.signal)
			.catch((reason: unknown) => reason);

		expect(error).toMatchObject({ code: "aborted" });
		expect(isOpenAICodexReauthenticationRequired(error)).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not write token refresh failures to stderr", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400)),
		);

		await expect(
			openaiCodexOAuth.refresh({
				type: "oauth",
				access: "invalid-access-token",
				refresh: "invalid-refresh-token",
				expires: 0,
			}),
		).rejects.toMatchObject({ code: "reauth_required" });
		expect(consoleError).not.toHaveBeenCalled();
	});
});
