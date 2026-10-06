import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { RefreshModelsContext } from "../models.ts";
import type { Model, ModelThinkingLevel } from "../types.ts";
import modelDataManifest from "./data/.manifest.json" with { type: "json" };

const PROVIDER = "openai-codex";
const BASE_URL = "https://chatgpt.com/backend-api";
const REFRESH_INTERVAL_MS = 4 * 60 * 60_000;
const THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const WIRE_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const CATALOG_SOURCE = `${BASE_URL}/codex/models`;
const validateTokenClaims = Compile(
	Type.Object({
		"https://api.openai.com/auth": Type.Object({ chatgpt_account_id: Type.String({ minLength: 1 }) }),
	}),
);
const catalogVersionSchema = Type.Object({ version: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" }) });
const validateVersion = Compile(catalogVersionSchema);
const nativeCatalogSchema = Type.Object({
	models: Type.Array(
		Type.Object({
			slug: Type.String({ minLength: 1, maxLength: 256 }),
			display_name: Type.String({ minLength: 1, maxLength: 256 }),
			visibility: Type.String(),
			context_window: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
			max_context_window: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
			supported_reasoning_levels: Type.Array(Type.Object({ effort: Type.String() })),
			input_modalities: Type.Optional(Type.Array(Type.String())),
		}),
	),
});
const validateNativeCatalog = Compile(nativeCatalogSchema);
const costRates = {
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Number({ minimum: 0 }),
	cacheWrite: Type.Number({ minimum: 0 }),
};
const metadataSchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 256 }),
	name: Type.String({ minLength: 1 }),
	reasoning: Type.Boolean(),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
	contextWindow: Type.Integer({ minimum: 1 }),
	maxTokens: Type.Integer({ minimum: 1 }),
	maxContextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
	cost: Type.Object({
		...costRates,
		tiers: Type.Optional(Type.Array(Type.Object({ inputTokensAbove: Type.Number({ minimum: 0 }), ...costRates }))),
	}),
	thinkingLevelMap: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
	compat: Type.Optional(
		Type.Object({
			supportsDeveloperRole: Type.Optional(Type.Boolean()),
			supportsLongCacheRetention: Type.Optional(Type.Boolean()),
			supportsStrictMode: Type.Optional(Type.Boolean()),
			supportsOpenAIGrammarTools: Type.Optional(Type.Boolean()),
			supportsToolSearch: Type.Optional(Type.Boolean()),
			supportsExplicitPromptCacheMode: Type.Optional(Type.Boolean()),
		}),
	),
});
const validateMetadata = Compile(metadataSchema);
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
		if (!validateMetadata.Check(row)) return [];
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
					if (!validateVersion.Check(version)) throw new Error("Codex catalog version metadata is invalid.");
					const headers = new Headers({ accept: "application/json", originator: "pi" });
					if (options.catalogAuthMode !== "transport") {
						const credential = context.credential;
						if (credential?.type !== "oauth")
							throw new Error("Codex catalog discovery requires OAuth or an authenticated host transport.");
						let accountId = credential.accountId;
						if (typeof accountId !== "string" || !accountId) {
							try {
								const payload: unknown = JSON.parse(atob(credential.access.split(".")[1] ?? ""));
								if (!validateTokenClaims.Check(payload)) throw new Error("Missing account ID");
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
					if (!validateNativeCatalog.Check(catalog))
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
