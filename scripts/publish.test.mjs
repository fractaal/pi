import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PUBLISHABLE_PACKAGES } from "./fractal-identity.mjs";

const publishScript = join(dirname(fileURLToPath(import.meta.url)), "publish.mjs");

/** A built workspace whose manifests carry the fork identity, as CI leaves them before publishing. */
async function builtWorkspace(t, version) {
	const root = await mkdtemp(join(tmpdir(), "publish-script-"));
	t.after(() => rm(root, { force: true, recursive: true }));
	for (const pkg of PUBLISHABLE_PACKAGES) {
		await mkdir(join(root, pkg.directory, "dist"), { recursive: true });
		await writeFile(join(root, pkg.directory, "dist", "index.js"), "export {};\n");
		await writeFile(
			join(root, pkg.directory, "package.json"),
			`${JSON.stringify({ name: pkg.name, version, files: ["dist"] }, null, "\t")}\n`,
		);
	}
	return root;
}

/** An `npm` that reports every package as unpublished, so the dry run needs no registry. */
async function offlineNpm(t) {
	const bin = await mkdtemp(join(tmpdir(), "publish-script-bin-"));
	t.after(() => rm(bin, { force: true, recursive: true }));
	const real = spawnSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).stdout.trim();
	const shim = join(bin, "npm");
	await writeFile(shim, `#!/bin/sh\nif [ "$1" = view ]; then echo "npm error code E404" >&2; exit 1; fi\nexec "${real}" "$@"\n`);
	await chmod(shim, 0o755);
	return bin;
}

test("dry-run validates every publishable package without publishing", { skip: process.platform === "win32" }, async (t) => {
	const root = await builtWorkspace(t, "9.9.9");
	const bin = await offlineNpm(t);

	const result = spawnSync(process.execPath, [publishScript, "--dry-run"], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
	});

	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /Publishing pi packages at 9\.9\.9 \(dry run\)/);
	for (const pkg of PUBLISHABLE_PACKAGES) {
		assert.match(result.stdout, new RegExp(`${pkg.name}@9\\.9\\.9 is not published`));
	}
	assert.doesNotMatch(result.stdout, /starting publication/);
});

test("refuses manifests that do not carry the fork identity", { skip: process.platform === "win32" }, async (t) => {
	const root = await builtWorkspace(t, "9.9.9");
	await writeFile(
		join(root, PUBLISHABLE_PACKAGES[0].directory, "package.json"),
		`${JSON.stringify({ name: PUBLISHABLE_PACKAGES[0].upstreamName, version: "9.9.9" })}\n`,
	);

	const result = spawnSync(process.execPath, [publishScript, "--dry-run"], { cwd: root, encoding: "utf8" });

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /fractal-identity\.mjs/);
});
