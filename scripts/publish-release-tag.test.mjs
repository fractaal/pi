import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PUBLISHABLE_PACKAGES } from "./fractal-identity.mjs";
import { publishReleaseTag, readRemoteTagCommit } from "./publish-release-tag.mjs";

const TAG = "fractaal-v0.84.0";

function git(root, ...args) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
	return (result.stdout ?? "").trim();
}

async function writeVersions(root, version) {
	for (const pkg of PUBLISHABLE_PACKAGES) {
		await mkdir(join(root, pkg.directory), { recursive: true });
		await writeFile(
			join(root, pkg.directory, "package.json"),
			`${JSON.stringify({ name: pkg.upstreamName, version }, null, "\t")}\n`,
		);
	}
}

/**
 * A real bare remote plus a clone, so ancestry and remote-tag state are genuine
 * rather than simulated. `merged` decides whether the release branch has reached
 * main, which is the gate this whole flow exists to enforce.
 */
async function releaseFixture(t, { version = "0.84.0", merged = true } = {}) {
	const root = await mkdtemp(join(tmpdir(), "publish-release-tag-"));
	t.after(() => rm(root, { force: true, recursive: true }));
	const remote = join(root, "remote.git");
	const repo = join(root, "repo");

	git(root, "init", "--bare", "-b", "main", remote);
	git(root, "clone", "--quiet", remote, repo);
	git(repo, "config", "user.email", "release@example.test");
	git(repo, "config", "user.name", "Release Test");
	git(repo, "commit", "--allow-empty", "-m", "Initial commit");
	git(repo, "push", "--quiet", "origin", "main");

	// What `npm run release:<bump>` leaves behind: a release branch carrying the
	// release commit, the local tag, and the next-cycle commit. Nothing pushed.
	git(repo, "checkout", "--quiet", "-b", "release/v0.84.0");
	await writeVersions(repo, version);
	git(repo, "add", "-A");
	git(repo, "commit", "-m", `Release ${TAG}`);
	const releaseCommit = git(repo, "rev-parse", "HEAD");
	git(repo, "tag", TAG);
	git(repo, "commit", "--allow-empty", "-m", "Add [Unreleased] section for next cycle");

	if (merged) {
		// A merge commit, which is what preserves the release commit's identity.
		git(repo, "checkout", "--quiet", "main");
		git(repo, "merge", "--no-ff", "--quiet", "release/v0.84.0", "-m", "Merge pull request #9");
		git(repo, "push", "--quiet", "origin", "main");
		git(repo, "fetch", "--quiet", "origin");
	}

	return { root, remote, repo, releaseCommit };
}

test("pushes the tag once the release commit is on main", async (t) => {
	const { repo, releaseCommit } = await releaseFixture(t);

	const result = publishReleaseTag(repo, TAG);

	assert.deepEqual(result, { version: "0.84.0", commit: releaseCommit, pushed: true });
	assert.equal(readRemoteTagCommit(repo, TAG), releaseCommit);
});

test("refuses to publish a tag whose commit is not on main", async (t) => {
	// The pull request has not been merged yet. This is the ordinary mistake the
	// gate exists for, and the tag is the point of no return.
	const { repo } = await releaseFixture(t, { merged: false });

	assert.throws(() => publishReleaseTag(repo, TAG), /not reachable from main/);
	assert.equal(readRemoteTagCommit(repo, TAG), undefined);
});

test("refuses a squash-merge outcome that leaves an equivalent commit", async (t) => {
	// Squash and rebase merges create a new commit. The release commit the tag names
	// is then not on main at all, however similar the replacement looks.
	const { repo } = await releaseFixture(t, { merged: false });
	git(repo, "checkout", "--quiet", "main");
	// Main moves on while the pull request is open, so the squashed commit has a
	// different parent and cannot coincide with the release commit.
	git(repo, "commit", "--allow-empty", "-m", "Unrelated change");
	git(repo, "merge", "--squash", "release/v0.84.0");
	git(repo, "commit", "-m", `Release ${TAG}`);
	git(repo, "push", "--quiet", "origin", "main");
	assert.notEqual(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", `refs/tags/${TAG}^{commit}`));

	assert.throws(() => publishReleaseTag(repo, TAG), /not reachable from main/);
	assert.equal(readRemoteTagCommit(repo, TAG), undefined);
});

test("judges ancestry against a freshly fetched main, not a stale local ref", async (t) => {
	const { remote, repo, releaseCommit } = await releaseFixture(t, { merged: false });

	// Another clone merges and pushes. This clone's origin/main is now stale, and a
	// gate that trusted it would refuse a release that is genuinely on main.
	const other = join(dirname(repo), "other");
	git(dirname(repo), "clone", "--quiet", remote, other);
	git(other, "config", "user.email", "release@example.test");
	git(other, "config", "user.name", "Release Test");
	git(other, "fetch", "--quiet", join(repo, ".git"), "release/v0.84.0");
	git(other, "merge", "--no-ff", "--quiet", "FETCH_HEAD", "-m", "Merge pull request #9");
	git(other, "push", "--quiet", "origin", "main");

	const result = publishReleaseTag(repo, TAG);
	assert.equal(result.commit, releaseCommit);
	assert.equal(readRemoteTagCommit(repo, TAG), releaseCommit);
});

test("publishes the verified commit even if the local tag moves during the push", async (t) => {
	// The local tag is mutable, so verification and publication are two moments. A
	// real Git shim moves the tag from the verified commit to another one at the last
	// possible instant, after every check has passed and while the push is executing.
	// A remote tag is immutable, so catching this on readback would already be too late.
	const { repo, releaseCommit } = await releaseFixture(t);
	const wrongCommit = git(repo, "rev-parse", "HEAD");
	assert.notEqual(wrongCommit, releaseCommit);

	const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
	const shimDir = join(repo, "..", "shim");
	await mkdir(shimDir, { recursive: true });
	await writeFile(
		join(shimDir, "git"),
		`#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "push" ]; then
    "${realGit}" -C "${repo}" tag -f "${TAG}" "${wrongCommit}" >/dev/null 2>&1
    break
  fi
done
exec "${realGit}" "$@"
`,
		{ mode: 0o755 },
	);

	const originalPath = process.env.PATH;
	process.env.PATH = `${shimDir}:${originalPath}`;
	try {
		const result = publishReleaseTag(repo, TAG);
		assert.equal(result.commit, releaseCommit);
	} finally {
		process.env.PATH = originalPath;
	}

	// The local tag really did move, so the fixture exercised the race rather than
	// silently doing nothing.
	assert.equal(git(repo, "rev-parse", `refs/tags/${TAG}^{commit}`), wrongCommit);
	// ...and the immutable remote tag is still the commit that was verified.
	assert.equal(readRemoteTagCommit(repo, TAG), releaseCommit);
});

test("is idempotent when the identical tag is already published", async (t) => {
	const { repo, releaseCommit } = await releaseFixture(t);
	publishReleaseTag(repo, TAG);

	const rerun = publishReleaseTag(repo, TAG);

	assert.deepEqual(rerun, { version: "0.84.0", commit: releaseCommit, pushed: false, reason: "already published" });
	assert.equal(readRemoteTagCommit(repo, TAG), releaseCommit);
});

test("refuses to move a remote tag that points somewhere else", async (t) => {
	const { repo, releaseCommit } = await releaseFixture(t);
	// Someone already published this tag from a different commit.
	const other = git(repo, "rev-parse", "HEAD");
	assert.notEqual(other, releaseCommit);
	git(repo, "push", "--quiet", "origin", `${other}:refs/tags/${TAG}`);

	assert.throws(() => publishReleaseTag(repo, TAG), /already points at .*Release tags are immutable/s);
	assert.equal(readRemoteTagCommit(repo, TAG), other);
});

test("refuses to publish from a dirty working tree", async (t) => {
	const { repo } = await releaseFixture(t);
	await writeFile(join(repo, "packages/ai/package.json"), '{ "name": "tampered" }\n');

	assert.throws(() => publishReleaseTag(repo, TAG), /Working tree is not clean/);
	assert.equal(readRemoteTagCommit(repo, TAG), undefined);
});

test("refuses a tagged commit whose versions disagree with the tag", async (t) => {
	const { repo } = await releaseFixture(t, { version: "0.83.0" });

	assert.throws(() => publishReleaseTag(repo, TAG), /is at version 0\.83\.0, expected 0\.84\.0/);
	assert.equal(readRemoteTagCommit(repo, TAG), undefined);
});

test("--dry-run verifies without pushing", async (t) => {
	const { repo, releaseCommit } = await releaseFixture(t);

	const result = publishReleaseTag(repo, TAG, { dryRun: true });

	assert.deepEqual(result, { version: "0.84.0", commit: releaseCommit, pushed: false, reason: "dry run" });
	assert.equal(readRemoteTagCommit(repo, TAG), undefined);
});

test("preparing a release never pushes protected main", async () => {
	// Static, and deliberately so: exercising release.mjs end to end would require a
	// real version bump, build and test run. The irreversible step, pushing the tag,
	// is covered behaviorally above; this covers the absence of a push in the
	// orchestration script that used to perform one.
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const release = await readFile(join(repoRoot, "scripts/release.mjs"), "utf8");

	// Only executed commands matter. The script legitimately prints `git push -u
	// origin <branch>` as an instruction for the operator's own release branch.
	const executed = [...release.matchAll(/\brun\(\s*[`"']([^`"']*)/g)].map((match) => match[1]);
	const pushes = executed.filter((command) => command.includes("push"));

	assert.deepEqual(pushes, [], "release.mjs must not push; main is protected and the tag waits for the merge");
	assert.match(release, /release:tag/, "release.mjs must hand off to the tag gate");
});
