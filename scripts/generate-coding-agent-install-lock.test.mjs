import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PUBLISHABLE_PACKAGES } from "./fractal-identity.mjs";

const scriptPath = fileURLToPath(new URL("./generate-coding-agent-install-lock.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceLockPath = join(repoRoot, "packages/coding-agent/install-lock/package-lock.json");

function runForkGenerator(outputDir) {
	const result = spawnSync(
		process.execPath,
		[scriptPath, "--fork-identity", "0.84.0", "--out-dir", outputDir],
		{ cwd: repoRoot, encoding: "utf8" },
	);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function registryTarballUrl(packageName) {
	const tarballName = packageName.split("/").at(-1);
	return `https://registry.npmjs.org/${packageName}/-/${tarballName}-0.84.0.tgz`;
}

test("generates fork installer assets without mutating source-controlled lock files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "fork-install-lock-"));
	t.after(() => rm(root, { force: true, recursive: true }));
	const sourceBefore = await readFile(sourceLockPath, "utf8");

	runForkGenerator(root);

	assert.equal(await readFile(sourceLockPath, "utf8"), sourceBefore);
	const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
	assert.deepEqual(packageJson.dependencies, { "@fractaal/pi-coding-agent": "0.84.0" });
	assert.equal(packageJson.name, "@fractaal/pi-coding-agent-install");
	assert.equal(lockfile.packages[""].dependencies["@fractaal/pi-coding-agent"], "0.84.0");

	for (const pkg of PUBLISHABLE_PACKAGES) {
		const expectedResolved = registryTarballUrl(pkg.name);
		assert.ok(
			Object.values(lockfile.packages).some(
				(entry) => entry.version === "0.84.0" && entry.resolved === expectedResolved,
			),
			`${pkg.name}@0.84.0 must resolve from the fork registry target`,
		);
	}

	for (const [lockPath, entry] of Object.entries(lockfile.packages)) {
		assert.doesNotMatch(entry.resolved ?? "", /registry\.npmjs\.org\/@earendil-works\/pi-/);
		for (const [dependencyName, dependencySpec] of Object.entries({
			...(entry.dependencies ?? {}),
			...(entry.optionalDependencies ?? {}),
		})) {
			if (!dependencyName.startsWith("@earendil-works/pi-")) continue;
			const target = PUBLISHABLE_PACKAGES.find((pkg) => pkg.upstreamName === dependencyName);
			assert.ok(target, `${lockPath} references an unpublished internal package ${dependencyName}`);
			assert.equal(dependencySpec, `npm:${target.name}@0.84.0`);
		}
	}
});
