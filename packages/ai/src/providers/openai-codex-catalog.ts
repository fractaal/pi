import { arr, bool, compile, int, map, nul, num, oneOf, opt, type Static, str, union } from "@earendil-works/pi-schema";
import type { RefreshModelsContext } from "../models.ts";
import type { Model, ModelThinkingLevel } from "../types.ts";
import modelDataManifest from "./data/.manifest.json" with { type: "json" };
import { openObject as object } from "./schema-builders.ts";

const PROVIDER = "openai-codex";
const BASE_URL = "https://chatgpt.com/backend-api";
const REFRESH_INTERVAL_MS = 4 * 60 * 60_000;
const THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const WIRE_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const CATALOG_SOURCE = `${BASE_URL}/codex/models`;
const validateTokenClaims = compile(
	object({
		"https://api.openai.com/auth": object({ chatgpt_account_id: str({ minLength: 1 }) }),
	}),
).check;
const catalogVersionSchema = object({ version: str({ pattern: "^\\d+\\.\\d+\\.\\d+$" }) });
const validateVersion = compile(catalogVersionSchema).check;
const nativeCatalogSchema = object({
	models: arr(
		object({
			slug: str({ minLength: 1, maxLength: 256 }),
			display_name: str({ minLength: 1, maxLength: 256 }),
			visibility: str(),
			context_window: opt(union([int({ minimum: 1 }), nul()])),
			max_context_window: opt(union([int({ minimum: 1 }), nul()])),
			supported_reasoning_levels: arr(object({ effort: str() })),
			input_modalities: opt(arr(str())),
		}),
	),
});
const validateNativeCatalog = compile(nativeCatalogSchema).check;
const costRates = {
	input: num({ minimum: 0 }),
	output: num({ minimum: 0 }),
	cacheRead: num({ minimum: 0 }),
	cacheWrite: num({ minimum: 0 }),
};
const metadataSchema = object({
	id: str({ minLength: 1, maxLength: 256 }),
	name: str({ minLength: 1 }),
	reasoning: bool(),
	input: arr(oneOf(["text", "image"])),
	contextWindow: int({ minimum: 1 }),
	maxTokens: int({ minimum: 1 }),
	maxContextWindow: opt(int({ minimum: 1 })),
	cost: object({
		...costRates,
		tiers: opt(arr(object({ inputTokensAbove: num({ minimum: 0 }), ...costRates }))),
	}),
	thinkingLevelMap: opt(map(union([str(), nul()]))),
	compat: opt(
		object({
			supportsDeveloperRole: opt(bool()),
			supportsLongCacheRetention: opt(bool()),
			supportsStrictMode: opt(bool()),
			supportsOpenAIGrammarTools: opt(bool()),
			supportsToolSearch: opt(bool()),
			supportsExplicitPromptCacheMode: opt(bool()),
		}),
	),
});
const validateMetadata = compile(metadataSchema).check;
type NativeModel = Static<typeof nativeCatalogSchema>["models"][number];
type CodexModel = Model<"openai-codex-responses">;

export interface OpenAICodexCatalogOptions {
	/** Native catalog transport only. Public version/pricing lookups never receive provider credentials. */
	catalogFetch?: typeof fetch;
	/** A host relay authenticates catalog requests instead of a local OAuth token. */
	catalogAuthMode?: "oauth" | "transport";
	/** Public metadata transport; useful for hosts with an explicit outbound HTTP adapter. */
	metadataFetch?: typeof fetch;
}

function parseMetadata(value: unknown): CodexModel[] {
	const rows: unknown[] = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null
			? Object.values(value)
			: [];
	return rows.flatMap((row) => {
		if (!validateMetadata(row)) return [];
		// Catalogs describe model data, never where OAuth credentials are sent.
		const { id, name, reasoning, input, contextWindow, maxTokens, maxContextWindow, cost, compat } = row;
		let thinkingLevelMap: CodexModel["thinkingLevelMap"];
		if (row.thinkingLevelMap) {
			thinkingLevelMap = {};
			for (const level of THINKING_LEVELS) {
				const mapped = row.thinkingLevelMap[level];
				if (mapped !== undefined)
					thinkingLevelMap[level] = mapped === null || WIRE_EFFORTS.has(mapped) ? mapped : null;
			}
		}
		return [
			{
				id,
				name,
				reasoning,
				input,
				contextWindow,
				maxTokens,
				maxContextWindow,
				cost,
				thinkingLevelMap,
				compat,
				provider: PROVIDER,
				api: "openai-codex-responses" as const,
				baseUrl: BASE_URL,
			},
		];
	});
}

function applyNativeMetadata(native: NativeModel, known: CodexModel): CodexModel {
	const thinkingLevelMap = { ...known.thinkingLevelMap };
	for (const { effort } of native.supported_reasoning_levels) {
		if (WIRE_EFFORTS.has(effort)) {
			thinkingLevelMap[(effort === "none" ? "off" : effort) as ModelThinkingLevel] = effort;
		}
	}
	const modalities = native.input_modalities?.filter(
		(value): value is "text" | "image" => value === "text" || value === "image",
	);
	const contextWindow = native.context_window ?? known.contextWindow;
	const maxContextWindow = native.max_context_window ?? known.maxContextWindow;
	if (maxContextWindow !== undefined && maxContextWindow < contextWindow) {
		throw new Error(`Codex catalog has inconsistent context limits for ${native.slug}.`);
	}
	return {
		...known,
		id: native.slug,
		name: native.display_name,
		contextWindow,
		maxContextWindow,
		reasoning: known.reasoning || native.supported_reasoning_levels.length > 0,
		thinkingLevelMap,
		input: modalities?.length ? modalities : known.input,
	};
}

/** Provider-owned, additive discovery over Pi's existing provider-scoped ModelsStore. */
export function createOpenAICodexCatalog(baseline: readonly CodexModel[], options: OpenAICodexCatalogOptions = {}) {
	let models = [...baseline];
	let pending: Promise<void> | undefined;
	const metadataFetch: typeof fetch = options.metadataFetch ?? ((url, init) => globalThis.fetch(url, init));
	const nativeFetch: typeof fetch = options.catalogFetch ?? ((url, init) => globalThis.fetch(url, init));

	return {
		getModels: (): readonly CodexModel[] => models,
		getAllModels: (): readonly CodexModel[] => models,
		refreshModels(context: RefreshModelsContext): Promise<void> {
			if (pending) return pending;
			const current = (async () => {
				try {
					const stored = context.stored;
					const generatedAt = Date.parse(modelDataManifest.generatedAt);
					const staleLegacyOverlay =
						stored?.source !== CATALOG_SOURCE &&
						(stored?.lastModified === undefined || stored.lastModified <= generatedAt);
					const baselineIds = new Set(baseline.map((model) => model.id));
					// Preserve the bundled fixes that previously superseded old pi.dev
					// overlays. Unknown IDs remain additive; native metadata owns its
					// own freshness rather than borrowing the public feed's timestamp.
					const cached = parseMetadata(stored?.models ?? []).filter(
						(model) => !staleLegacyOverlay || !baselineIds.has(model.id),
					);
					models = [...new Map([...baseline, ...cached].map((model) => [model.id, model])).values()];
					if (!context.allowNetwork || context.signal?.aborted) return;
					if (
						!context.force &&
						stored?.source === CATALOG_SOURCE &&
						stored.checkedAt &&
						Date.now() - stored.checkedAt < REFRESH_INTERVAL_MS
					)
						return;
					const signal = AbortSignal.any([AbortSignal.timeout(20_000), context.signal]);
					// This is a catalog-query version, not an executable download or a
					// claim that Pi implements every feature of that Codex CLI release.
					const versionResponse = await metadataFetch("https://registry.npmjs.org/@openai/codex/latest", {
						signal,
					});
					if (!versionResponse.ok)
						throw new Error(`Codex catalog version lookup failed (${versionResponse.status}).`);
					const version: unknown = await versionResponse.json();
					if (!validateVersion(version)) throw new Error("Codex catalog version metadata is invalid.");
					const headers = new Headers({ accept: "application/json", originator: "pi" });
					if (options.catalogAuthMode !== "transport") {
						const credential = context.credential;
						if (credential?.type !== "oauth")
							throw new Error("Codex catalog discovery requires OAuth or an authenticated host transport.");
						let accountId = credential.accountId;
						if (typeof accountId !== "string" || !accountId) {
							try {
								const payload: unknown = JSON.parse(atob(credential.access.split(".")[1] ?? ""));
								if (!validateTokenClaims(payload)) throw new Error("Missing account ID");
								accountId = payload["https://api.openai.com/auth"].chatgpt_account_id;
							} catch {
								throw new Error("Codex catalog credential has no account ID.");
							}
						}
						if (typeof accountId !== "string" || !accountId)
							throw new Error("Codex catalog credential has no account ID.");
						headers.set("Authorization", `Bearer ${credential.access}`);
						headers.set("chatgpt-account-id", accountId);
					}
					const response = await nativeFetch(
						`${CATALOG_SOURCE}?client_version=${encodeURIComponent(version.version)}`,
						{ headers, signal },
					);
					if (!response.ok) throw new Error(`Codex model discovery failed (${response.status}).`);
					const catalog: unknown = await response.json();
					if (!validateNativeCatalog(catalog))
						throw new Error("Codex model discovery returned an invalid catalog.");
					let metadata: CodexModel[] = [];
					let metadataError: Error | undefined;
					try {
						const enrichment = await metadataFetch("https://pi.dev/api/models/providers/openai-codex", {
							signal,
							headers: { accept: "application/json" },
						});
						if (!enrichment.ok) throw new Error(`Codex model metadata request failed (${enrichment.status}).`);
						metadata = parseMetadata(await enrichment.json());
					} catch (error) {
						metadataError = error instanceof Error ? error : new Error("Codex model metadata is unavailable.");
					}
					signal.throwIfAborted();
					const known = new Map([...models, ...metadata].map((model) => [model.id, model]));
					const merged = new Map(models.map((model) => [model.id, model]));
					const missing: string[] = [];
					for (const model of catalog.models) {
						if (model.visibility !== "list" && !merged.has(model.slug)) continue;
						const details = known.get(model.slug);
						if (!details) {
							missing.push(model.slug);
							continue;
						}
						merged.set(model.slug, applyNativeMetadata(model, details));
					}
					const refreshed = [...merged.values()];
					await context.publish({
						persist: { models: refreshed, source: CATALOG_SOURCE, checkedAt: Date.now() },
						update: () => {
							models = refreshed;
						},
					});
					if (missing.length)
						throw new Error(
							`Codex catalog refreshed; these models await output/pricing metadata: ${missing.join(", ")}.`,
						);
					if (metadataError) throw metadataError;
				} finally {
					// Settled only after assignment below, even when the body finishes synchronously.
					queueMicrotask(() => {
						if (pending === current) pending = undefined;
					});
				}
			})();
			pending = current;
			return current;
		},
	};
}
