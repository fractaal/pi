#!/usr/bin/env node
/**
 * The fork's single packaging-boundary transformation.
 *
 * The source tree keeps upstream's `@earendil-works/*` package names so upstream
 * merges stay mechanical: renaming them would conflict in every file that imports
 * one. Publication is therefore the only place the fork identity appears. This
 * module rewrites the publishable manifests to `@fractaal/*`, pins their internal
 * dependencies to the exact version being published, and points repository
 * metadata at the fork.
 *
 * It runs in place immediately before `scripts/publish.mjs`, which then publishes
 * exactly the way upstream does: same tag-triggered workflow, same idempotency
 * checks, same npm trusted publishing, normal `latest` dist-tag.
 *
 *   node scripts/fractal-identity.mjs <x.y.z>
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Dependency order: each package is published before anything that depends on it. */
export const PUBLISHABLE_PACKAGES = [
	{ directory: "packages/ai", upstreamName: "@earendil-works/pi-ai", name: "@fractaal/pi-ai" },
	{ directory: "packages/agent", upstreamName: "@earendil-works/pi-agent-core", name: "@fractaal/pi-agent-core" },
	{ directory: "packages/tui", upstreamName: "@earendil-works/pi-tui", name: "@fractaal/pi-tui" },
	{
		directory: "packages/coding-agent",
		upstreamName: "@earendil-works/pi-coding-agent",
		name: "@fractaal/pi-coding-agent",
	},
];

/**
 * Fork release tags. Upstream `v*` tags arrive through merges and share the same
 * Git tag namespace, so the release workflow keys off this prefix only and never
 * fires on an upstream tag.
 */
export const RELEASE_TAG_PREFIX = "fractaal-v";

export const FORK_REPOSITORY_URL = "git+https://github.com/fractaal/pi.git";
export const FORK_HOMEPAGE = "https://github.com/fractaal/pi";
export const FORK_BUGS_URL = "https://github.com/fractaal/pi/issues";

/** Fork releases are ordinary stable SemVer on the ordinary `latest` tag. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DEPENDENCY_GROUPS = ["dependencies", "peerDependencies", "optionalDependencies"];
const UPSTREAM_SCOPE = "@earendil-works/";

export function assertReleaseVersion(version) {
	if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
		throw new Error(
			`Invalid fork release version ${JSON.stringify(version)}. Expected stable SemVer such as 0.84.0. ` +
				`The -fractal.N suffix and npm "fractal" dist-tag are retired.`,
		);
	}
	return version;
}

/**
 * Pure manifest transform, so the packaging contract can be tested without a
 * checkout. Returns a new manifest; never mutates the input.
 */
export function toFractalManifest(manifest, version) {
	assertReleaseVersion(version);
	const pkg = PUBLISHABLE_PACKAGES.find((candidate) => candidate.upstreamName === manifest.name);
	if (!pkg) {
		throw new Error(`${manifest.name} is not a publishable fork package`);
	}

	const next = {
		...manifest,
		name: pkg.name,
		version,
		repository: { type: "git", url: FORK_REPOSITORY_URL, directory: pkg.directory },
		homepage: FORK_HOMEPAGE,
		bugs: { url: FORK_BUGS_URL },
	};

	for (const group of DEPENDENCY_GROUPS) {
		const deps = next[group];
		if (!deps) continue;
		const rewritten = { ...deps };
		for (const dependency of Object.keys(rewritten)) {
			if (!dependency.startsWith(UPSTREAM_SCOPE)) continue;
			const target = PUBLISHABLE_PACKAGES.find((candidate) => candidate.upstreamName === dependency);
			if (!target) {
				// A fork package depending on an upstream package the fork does not
				// publish would resolve to upstream's code at install time.
				throw new Error(
					`${pkg.name} depends on ${dependency}, which the fork does not publish. ` +
						`Add it to PUBLISHABLE_PACKAGES or drop the dependency.`,
				);
			}
			// Keep the upstream key so the fork's own `import "@earendil-works/..."`
			// statements still resolve; only the resolution target changes.
			rewritten[dependency] = `npm:${target.name}@${version}`;
		}
		next[group] = rewritten;
	}

	return next;
}

/**
 * Shipped by upstream inside the coding-agent tarball, where it pins the exact
 * upstream tarballs of the internal packages. Publishing it under the fork scope
 * would make every install resolve back to `@earendil-works/*`, and a correct
 * fork shrinkwrap cannot exist before the fork tarballs are published, because it
 * would have to contain their integrity hashes. Drop it instead: npm silently
 * skips `files` entries that do not exist.
 */
const SHRINKWRAP = join("packages/coding-agent", "npm-shrinkwrap.json");

export function applyFractalIdentity(repoRoot, version) {
	assertReleaseVersion(version);
	const applied = [];
	for (const pkg of PUBLISHABLE_PACKAGES) {
		const manifestPath = join(repoRoot, pkg.directory, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		const next = toFractalManifest(manifest, version);
		writeFileSync(manifestPath, `${JSON.stringify(next, null, "\t")}\n`);
		applied.push({ name: next.name, version: next.version, manifestPath });
	}

	const shrinkwrapPath = join(repoRoot, SHRINKWRAP);
	const removedShrinkwrap = existsSync(shrinkwrapPath);
	if (removedShrinkwrap) {
		rmSync(shrinkwrapPath);
	}

	return { packages: applied, removedShrinkwrap };
}

const isDirectInvocation = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectInvocation) {
	const version = process.argv[2];
	try {
		assertReleaseVersion(version);
	} catch (error) {
		console.error(String(error.message ?? error));
		console.error("usage: node scripts/fractal-identity.mjs <x.y.z>");
		process.exit(1);
	}

	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const result = applyFractalIdentity(repoRoot, version);
	for (const applied of result.packages) {
		console.log(`  ${applied.name}@${applied.version}`);
	}
	if (result.removedShrinkwrap) {
		console.log(`  removed ${SHRINKWRAP} (pins upstream tarballs)`);
	}
}
