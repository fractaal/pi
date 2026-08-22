import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("./release-notes.mjs", import.meta.url));
const CHANGELOG = `# Changelog

## [0.84.0] - 2026-08-22

### Added

- See [the extension docs](docs/extensions.md#ctxonidlecallback).
`;

async function extractNotes(t, args) {
	const root = await mkdtemp(join(tmpdir(), "release-notes-"));
	t.after(() => rm(root, { force: true, recursive: true }));
	const changelogPath = join(root, "CHANGELOG.md");
	const outputPath = join(root, "RELEASE_NOTES.md");
	await writeFile(changelogPath, CHANGELOG);
	const result = spawnSync(
		process.execPath,
		[scriptPath, "extract", "--version", "0.84.0", "--changelog", changelogPath, "--out", outputPath, ...args],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	return readFile(outputPath, "utf8");
}

test("preserves the Fractaal release tag instead of prepending v", async (t) => {
	const notes = await extractNotes(t, ["--tag", "fractaal-v0.84.0", "--repo", "fractaal/pi"]);
	assert.match(notes, /github\.com\/fractaal\/pi\/blob\/fractaal-v0\.84\.0\//);
	assert.doesNotMatch(notes, /vfractaal-v0\.84\.0/);
});

test("defaults release-note links to the Fractaal repository", async (t) => {
	const notes = await extractNotes(t, ["--tag", "fractaal-v0.84.0"]);
	assert.match(notes, /https:\/\/github\.com\/fractaal\/pi\/blob\/fractaal-v0\.84\.0\//);
	assert.doesNotMatch(notes, /earendil-works\/pi/);
});

test("preserves the upstream repository for ordinary v tags", async (t) => {
	const notes = await extractNotes(t, ["--tag", "v0.83.0"]);
	assert.match(notes, /https:\/\/github\.com\/earendil-works\/pi\/blob\/v0\.83\.0\//);
	assert.doesNotMatch(notes, /github\.com\/fractaal\/pi/);
});
