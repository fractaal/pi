import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	applyFractalIdentity,
	applyFractalIdentityToManifestFile,
	assertReleaseVersion,
	PUBLISHABLE_PACKAGES,
	toFractalManifest,
} from "./fractal-identity.mjs";

const scriptPath = fileURLToPath(new URL("./fractal-identity.mjs", import.meta.url));

function upstreamManifest(name, overrides = {}) {
	return {
		name,
		version: "0.83.0",
		repository: { type: "git", url: "git+https://github.com/earendil-works/pi.git", directory: "packages/x" },
		...overrides,
	};
}

async function writeManifest(root, directory, manifest) {
	await mkdir(join(root, directory), { recursive: true });
	await writeFile(join(root, directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readManifest(root, directory) {
	return JSON.parse(await readFile(join(root, directory, "package.json"), "utf8"));
}

test("publishes the fork scope, never upstream's", () => {
	for (const pkg of PUBLISHABLE_PACKAGES) {
		assert.ok(pkg.name.startsWith("@fractaal/"), `${pkg.name} must publish under @fractaal`);
		assert.ok(pkg.upstreamName.startsWith("@earendil-works/"), `${pkg.upstreamName} must be the upstream name`);
	}
	const manifest = toFractalManifest(upstreamManifest("@earendil-works/pi-ai"), "0.84.0");
	assert.equal(manifest.name, "@fractaal/pi-ai");
});

test("rejects the retired -fractal.N version suffix", () => {
	assert.throws(() => assertReleaseVersion("0.84.0-fractal.1"), /Invalid fork release version/);
	assert.throws(() => assertReleaseVersion("0.83.0-fractal.7"), /Invalid fork release version/);
	assert.throws(() => assertReleaseVersion("v0.84.0"), /Invalid fork release version/);
	assert.throws(() => assertReleaseVersion(""), /Invalid fork release version/);
	assert.equal(assertReleaseVersion("0.84.0"), "0.84.0");
});

test("pins internal dependencies to the exact fork version", () => {
	const manifest = toFractalManifest(
		upstreamManifest("@earendil-works/pi-coding-agent", {
			dependencies: {
				"@earendil-works/pi-agent-core": "^0.83.0",
				"@earendil-works/pi-ai": "^0.83.0",
				"@earendil-works/pi-tui": "^0.83.0",
				semver: "7.8.0",
			},
			optionalDependencies: { "@mariozechner/clipboard": "0.3.9" },
		}),
		"0.84.0",
	);

	// The upstream key stays so the fork's own imports still resolve; only the
	// resolution target changes, and it is exact rather than a range.
	assert.deepEqual(manifest.dependencies, {
		"@earendil-works/pi-agent-core": "npm:@fractaal/pi-agent-core@0.84.0",
		"@earendil-works/pi-ai": "npm:@fractaal/pi-ai@0.84.0",
		"@earendil-works/pi-tui": "npm:@fractaal/pi-tui@0.84.0",
		semver: "7.8.0",
	});
	assert.deepEqual(manifest.optionalDependencies, { "@mariozechner/clipboard": "0.3.9" });
});

test("refuses to publish a fork package that depends on an unpublished upstream package", () => {
	assert.throws(
		() =>
			toFractalManifest(
				upstreamManifest("@earendil-works/pi-coding-agent", {
					dependencies: { "@earendil-works/pi-storage-sqlite-node": "^0.83.0" },
				}),
				"0.84.0",
			),
		/the fork does not publish/,
	);
});

test("points package metadata at the fork repository", () => {
	const manifest = toFractalManifest(upstreamManifest("@earendil-works/pi-tui"), "0.84.0");
	assert.deepEqual(manifest.repository, {
		type: "git",
		url: "git+https://github.com/fractaal/pi.git",
		directory: "packages/tui",
	});
	assert.equal(manifest.homepage, "https://github.com/fractaal/pi");
	assert.deepEqual(manifest.bugs, { url: "https://github.com/fractaal/pi/issues" });
	assert.ok(!JSON.stringify(manifest).includes("earendil-works/pi.git"));
});

test("does not mutate the manifest it was given", () => {
	const original = upstreamManifest("@earendil-works/pi-ai", {
		dependencies: { "@earendil-works/pi-tui": "^0.83.0" },
	});
	const snapshot = structuredClone(original);
	toFractalManifest(original, "0.84.0");
	assert.deepEqual(original, snapshot);
});

test("applies the identity across the tree and drops the upstream-pinned shrinkwrap", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "fractal-identity-"));
	t.after(() => rm(root, { force: true, recursive: true }));

	for (const pkg of PUBLISHABLE_PACKAGES) {
		await writeManifest(root, pkg.directory, upstreamManifest(pkg.upstreamName));
	}
	const shrinkwrap = join(root, "packages/coding-agent/npm-shrinkwrap.json");
	await writeFile(shrinkwrap, JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));

	const result = applyFractalIdentity(root, "0.84.0");

	assert.equal(result.packages.length, PUBLISHABLE_PACKAGES.length);
	assert.equal(result.removedShrinkwrap, true);
	// It pins upstream tarballs by integrity hash, so shipping it under the fork
	// scope would make every install resolve back to @earendil-works.
	assert.equal(existsSync(shrinkwrap), false);
	for (const pkg of PUBLISHABLE_PACKAGES) {
		const manifest = await readManifest(root, pkg.directory);
		assert.equal(manifest.name, pkg.name);
		assert.equal(manifest.version, "0.84.0");
	}
});

test("transforms a staged binary sidecar without changing source-tree cleanup state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "fractal-sidecar-"));
	t.after(() => rm(root, { force: true, recursive: true }));
	const manifestPath = join(root, "linux-x64", "package.json");
	await writeManifest(root, "linux-x64", upstreamManifest("@earendil-works/pi-coding-agent", {
		version: "0.84.0",
		piConfig: { buildSignature: "fractal" },
		dependencies: {
			"@earendil-works/pi-agent-core": "^0.84.0",
			"@earendil-works/pi-ai": "^0.84.0",
			"@earendil-works/pi-tui": "^0.84.0",
		},
	}));

	const result = applyFractalIdentityToManifestFile(manifestPath, "0.84.0");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

	assert.equal(result.name, "@fractaal/pi-coding-agent");
	assert.equal(manifest.name, "@fractaal/pi-coding-agent");
	assert.equal(manifest.version, "0.84.0");
	assert.equal(manifest.piConfig.buildSignature, "fractal");
	assert.deepEqual(manifest.dependencies, {
		"@earendil-works/pi-agent-core": "npm:@fractaal/pi-agent-core@0.84.0",
		"@earendil-works/pi-ai": "npm:@fractaal/pi-ai@0.84.0",
		"@earendil-works/pi-tui": "npm:@fractaal/pi-tui@0.84.0",
	});
});

/**
 * The CLI resolves the repository from its own location, so it is copied into the
 * sandbox before running. Invoking the real script would rewrite the real tree,
 * which is exactly what happened once while mutation-testing the version guard.
 */
async function sandboxedCli(t) {
	const root = await mkdtemp(join(tmpdir(), "fractal-identity-cli-"));
	t.after(() => rm(root, { force: true, recursive: true }));
	await mkdir(join(root, "scripts"), { recursive: true });
	const sandboxedScript = join(root, "scripts", "fractal-identity.mjs");
	await copyFile(scriptPath, sandboxedScript);
	for (const pkg of PUBLISHABLE_PACKAGES) {
		await writeManifest(root, pkg.directory, upstreamManifest(pkg.upstreamName));
	}
	return { root, script: sandboxedScript };
}

test("the CLI refuses a suffixed version and changes nothing", async (t) => {
	const { root, script } = await sandboxedCli(t);

	const result = spawnSync(process.execPath, [script, "0.84.0-fractal.1"], { encoding: "utf8" });

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Invalid fork release version/);
	assert.equal((await readManifest(root, "packages/ai")).name, "@earendil-works/pi-ai");
});

test("the CLI applies the identity for a stable version", async (t) => {
	const { root, script } = await sandboxedCli(t);

	const result = spawnSync(process.execPath, [script, "0.84.0"], { encoding: "utf8" });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /@fractaal\/pi-coding-agent@0\.84\.0/);
	assert.equal((await readManifest(root, "packages/ai")).name, "@fractaal/pi-ai");
	assert.equal((await readManifest(root, "packages/ai")).version, "0.84.0");
});

test("the CLI applies identity to a staged sidecar manifest", async (t) => {
	const { root, script } = await sandboxedCli(t);
	await writeManifest(root, "binary/linux-x64", upstreamManifest("@earendil-works/pi-coding-agent", {
		piConfig: { buildSignature: "fractal" },
	}));
	const manifestPath = join(root, "binary/linux-x64/package.json");

	const result = spawnSync(process.execPath, [script, "--manifest", manifestPath, "0.84.0"], { encoding: "utf8" });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /@fractaal\/pi-coding-agent@0\.84\.0/);
	assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).name, "@fractaal/pi-coding-agent");
});
