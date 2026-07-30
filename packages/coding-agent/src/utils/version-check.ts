import { compare, valid } from "semver";
import { BUILD_SIGNATURE, PACKAGE_NAME } from "../config.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;
/** The dist-tag this fork publishes under; also its piConfig.buildSignature. */
const FORK_DIST_TAG = "fractal";
/**
 * Scope the fork publishes under. Checked alongside the build signature because
 * this repo carries `buildSignature: "fractal"` in source while keeping upstream's
 * package name — only a *published* fork build has both, and only a published
 * build can be clobbered by a self-update. In-repo dev builds keep pi.dev.
 */
const FORK_PACKAGE_SCOPE = "@fractaal/";

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

/**
 * Fork builds resolve their own npm dist-tag instead of pi.dev.
 *
 * pi.dev reports `packageName: "@earendil-works/pi-coding-agent"`, and the
 * self-update guard treats a differing package name as a rename migration and
 * installs it unconditionally — so an unguarded fork build would replace itself
 * with upstream. Returning this fork's own name makes that clause unreachable.
 *
 * Fails closed: a registry error yields undefined ("no update available"), never
 * a fallback to upstream. Reads the `fractal` tag explicitly, never `latest`,
 * which is stale on this scope and would silently downgrade.
 */
async function getLatestForkRelease(
	currentVersion: string,
	options: { timeoutMs?: number },
): Promise<LatestPiRelease | undefined> {
	const url = `https://registry.npmjs.org/-/package/${encodeURIComponent(PACKAGE_NAME)}/dist-tags`;
	const response = await fetch(url, {
		headers: {
			"User-Agent": getPiUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const tags = (await response.json()) as Record<string, unknown>;
	const version = tags[FORK_DIST_TAG];
	if (typeof version !== "string" || !version.trim()) return undefined;
	return { version: version.trim(), packageName: PACKAGE_NAME };
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;
	if (BUILD_SIGNATURE === FORK_DIST_TAG && PACKAGE_NAME.startsWith(FORK_PACKAGE_SCOPE)) {
		return getLatestForkRelease(currentVersion, options);
	}

	const response = await fetch(LATEST_VERSION_URL, {
		headers: {
			"User-Agent": getPiUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		packageName,
		...(note ? { note } : {}),
	};
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
