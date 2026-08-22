import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { PUBLISHABLE_PACKAGES } from "./fractal-identity.mjs";
import { parseReleaseTag, verifyReleaseSource, verifyRemoteReleaseTag } from "./verify-release-source.mjs";

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
 * A miniature of what scripts/release.mjs produces: a release commit on main
 * carrying the tag version, the tag, then the next-cycle commit.
 */
async function releaseRepo(t, { version = "0.84.0", tag = "fractaal-v0.84.0" } = {}) {
	const root = await mkdtemp(join(tmpdir(), "verify-release-source-"));
	t.after(() => rm(root, { force: true, recursive: true }));

	git(root, "init", "-b", "main");
	git(root, "config", "user.email", "release@example.test");
	git(root, "config", "user.name", "Release Test");
	git(root, "commit", "--allow-empty", "-m", "Initial commit");

	await writeVersions(root, version);
	git(root, "add", "-A");
	git(root, "commit", "-m", `Release ${tag}`);
	git(root, "tag", tag);
	const releaseCommit = git(root, "rev-parse", "HEAD");

	git(root, "commit", "--allow-empty", "-m", "Add [Unreleased] section for next cycle");
	git(root, "checkout", "--quiet", tag);

	return { root, tag, version, releaseCommit };
}

test("parses only fork release tags", () => {
	assert.equal(parseReleaseTag("fractaal-v0.84.0"), "0.84.0");
	assert.throws(() => parseReleaseTag("v0.84.0"), /not a fork release tag/);
	assert.throws(() => parseReleaseTag("fractaal-v0.84.0-fractal.1"), /not a fork release tag/);
	assert.throws(() => parseReleaseTag(undefined), /not a fork release tag/);
});

test("accepts the tagged release commit on main", async (t) => {
	const { root, tag, version, releaseCommit } = await releaseRepo(t);

	assert.deepEqual(verifyReleaseSource(root, tag), { version, commit: releaseCommit });
});

test("accepts an ordinary recovery rerun of the same tag", async (t) => {
	const { root, tag, version, releaseCommit } = await releaseRepo(t);

	// A rerun is a fresh checkout of the same immutable tag, which is exactly the
	// state a recovery dispatch produces now that no source ref can be supplied.
	git(root, "checkout", "--quiet", "main");
	git(root, "checkout", "--quiet", tag);

	assert.deepEqual(verifyReleaseSource(root, tag), { version, commit: releaseCommit });
});

test("rejects a release tag that is not on main", async (t) => {
	const { root, tag } = await releaseRepo(t);

	git(root, "checkout", "--quiet", "-b", "side", "main");
	git(root, "commit", "--allow-empty", "-m", `Release ${tag}`);
	git(root, "tag", "-f", tag);
	git(root, "checkout", "--quiet", tag);

	assert.throws(() => verifyReleaseSource(root, tag), /not reachable from main/);
});

test("rejects the next-cycle commit", async (t) => {
	const { root, tag } = await releaseRepo(t);

	git(root, "checkout", "--quiet", "main");
	git(root, "tag", "-f", tag);
	git(root, "checkout", "--quiet", tag);

	assert.throws(() => verifyReleaseSource(root, tag), /Add \[Unreleased\] section for next cycle/);
});

test("rejects a source version that disagrees with the tag", async (t) => {
	const { root, tag } = await releaseRepo(t, { version: "0.83.0" });

	assert.throws(() => verifyReleaseSource(root, tag), /is at version 0\.83\.0, expected 0\.84\.0/);
});

test("rejects a checkout that is not the tag target", async (t) => {
	const { root, tag } = await releaseRepo(t);

	git(root, "checkout", "--quiet", "main");

	assert.throws(() => verifyReleaseSource(root, tag), /is not the fractaal-v0\.84\.0 target/);
});

test("rejects a tag that does not exist in the checkout", async (t) => {
	const { root } = await releaseRepo(t);

	assert.throws(() => verifyReleaseSource(root, "fractaal-v9.9.9"), /does not exist in this checkout/);
});

test("rejects a tag moved to a second equally valid release commit", async (t) => {
	// The cross-job race: a tag is a mutable ref, so build can verify commit A and a
	// later job can verify commit B, with both passing every other check. Publication
	// pins to A, so a moved tag must fail rather than silently shipping B.
	const { root, tag, version, releaseCommit: commitA } = await releaseRepo(t);

	git(root, "checkout", "--quiet", "main");
	await writeVersions(root, version);
	await writeFile(join(root, "packages/ai/extra.txt"), "second release commit\n");
	git(root, "add", "-A");
	git(root, "commit", "-m", `Release ${tag}`);
	const commitB = git(root, "rev-parse", "HEAD");
	assert.notEqual(commitA, commitB);

	// Commit B is itself a perfectly valid release commit: same subject, same
	// versions, on main. It verifies on its own.
	git(root, "tag", "-f", tag);
	assert.deepEqual(verifyReleaseSource(root, tag), { version, commit: commitB });

	// Now the publish job, pinned to build's verified commit A, re-runs the verifier.
	git(root, "checkout", "--quiet", commitA);
	assert.throws(() => verifyReleaseSource(root, tag), /is not the .* target/);
});

test("rejects a remote tag moved after the publish checkout was fetched", async (t) => {
	// The real remote/local boundary. Moving a tag inside one repository updates the
	// local ref, so every local check sees it. A publish job holds a snapshot fetched
	// minutes earlier, and that snapshot stays stale when the public tag moves.
	const root = await mkdtemp(join(tmpdir(), "verify-remote-tag-"));
	t.after(() => rm(root, { force: true, recursive: true }));

	const remote = join(root, "remote.git");
	const origin = join(root, "origin");
	const publish = join(root, "publish");
	const tag = "fractaal-v0.84.0";

	git(root, "init", "--bare", "-b", "main", remote);
	git(root, "clone", "--quiet", remote, origin);
	git(origin, "config", "user.email", "release@example.test");
	git(origin, "config", "user.name", "Release Test");
	git(origin, "commit", "--allow-empty", "-m", "Initial commit");

	await writeVersions(origin, "0.84.0");
	git(origin, "add", "-A");
	git(origin, "commit", "-m", `Release ${tag}`);
	const commitA = git(origin, "rev-parse", "HEAD");
	git(origin, "tag", tag);
	git(origin, "push", "--quiet", "origin", "main", tag);

	// The publish job's checkout: it fetches the tag once, pinned at commit A.
	git(root, "clone", "--quiet", remote, publish);
	git(publish, "checkout", "--quiet", commitA);
	assert.equal(git(publish, "rev-parse", `refs/tags/${tag}^{commit}`), commitA);

	// Meanwhile the public tag moves to a second, independently valid release commit.
	await writeVersions(origin, "0.84.0");
	await writeFile(join(origin, "packages/ai/extra.txt"), "second release commit\n");
	git(origin, "add", "-A");
	git(origin, "commit", "-m", `Release ${tag}`);
	const commitB = git(origin, "rev-parse", "HEAD");
	git(origin, "tag", "-f", tag);
	git(origin, "push", "--quiet", "--force", "origin", "main", tag);
	assert.notEqual(commitA, commitB);

	// The publish checkout has not refetched, so its local snapshot is still A.
	assert.equal(git(publish, "rev-parse", `refs/tags/${tag}^{commit}`), commitA);

	// This is the gap: every local invariant still passes against the stale snapshot.
	assert.deepEqual(verifyReleaseSource(publish, tag), { version: "0.84.0", commit: commitA });

	// Asking origin directly is what catches it.
	assert.throws(
		() => verifyRemoteReleaseTag(publish, tag, commitA),
		/points at .*but publication is pinned to/,
	);

	// And it accepts when the remote genuinely still agrees.
	assert.deepEqual(verifyRemoteReleaseTag(publish, tag, commitB), { commit: commitB });
});

test("peels an annotated remote tag to its commit", async (t) => {
	// release.mjs creates lightweight tags, where ls-remote reports the commit
	// directly. An annotated tag reports its own object under refs/tags/<tag> and the
	// commit under refs/tags/<tag>^{}, so comparing the unpeeled line would reject a
	// perfectly good release.
	const root = await mkdtemp(join(tmpdir(), "verify-remote-annotated-"));
	t.after(() => rm(root, { force: true, recursive: true }));

	const remote = join(root, "remote.git");
	const clone = join(root, "clone");
	const tag = "fractaal-v0.84.0";

	git(root, "init", "--bare", "-b", "main", remote);
	git(root, "clone", "--quiet", remote, clone);
	git(clone, "config", "user.email", "release@example.test");
	git(clone, "config", "user.name", "Release Test");
	git(clone, "commit", "--allow-empty", "-m", `Release ${tag}`);
	const commit = git(clone, "rev-parse", "HEAD");
	git(clone, "tag", "-a", tag, "-m", `Release ${tag}`);
	git(clone, "push", "--quiet", "origin", "main", tag);

	// The tag object itself is a different SHA from the commit it points at.
	assert.notEqual(git(clone, "rev-parse", `refs/tags/${tag}`), commit);
	assert.deepEqual(verifyRemoteReleaseTag(clone, tag, commit), { commit });
});

test("fails closed when the release tag is absent from the remote", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "verify-remote-missing-"));
	t.after(() => rm(root, { force: true, recursive: true }));

	const remote = join(root, "remote.git");
	const clone = join(root, "clone");
	git(root, "init", "--bare", "-b", "main", remote);
	git(root, "clone", "--quiet", remote, clone);
	git(clone, "config", "user.email", "release@example.test");
	git(clone, "config", "user.name", "Release Test");
	git(clone, "commit", "--allow-empty", "-m", "Initial commit");
	git(clone, "push", "--quiet", "origin", "main");

	assert.throws(
		() => verifyRemoteReleaseTag(clone, "fractaal-v0.84.0", git(clone, "rev-parse", "HEAD")),
		/does not exist on origin/,
	);
});

test("CI and release build from the committed model catalog", async () => {
	// The model types are derived from packages/ai/src/providers/data at compile
	// time. Regenerating that data from live provider APIs during a build makes the
	// same commit typecheck differently on different days, and makes published
	// artifacts depend on a third-party feed rather than the release commit.
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const read = async (path) => await readFile(join(repoRoot, path), "utf8");

	const gitignore = await read(".gitignore");
	assert.ok(
		!/^packages\/ai\/src\/providers\/data\/?$/m.test(gitignore),
		"the model catalog must be committed source, not ignored",
	);

	for (const path of [".github/workflows/ci.yml", ".github/workflows/build-binaries.yml"]) {
		const workflow = parseYaml(await read(path));
		for (const [jobName, job] of Object.entries(workflow.jobs)) {
			for (const step of job.steps ?? []) {
				const run = String(step.run ?? "");
				assert.ok(
					!/npm run build(\s|$)/.test(run),
					`${path} ${jobName} runs \`npm run build\`, which regenerates the catalog live; use build:offline`,
				);
				assert.ok(
					!/hydrate:model-data|generate:models/.test(run),
					`${path} ${jobName} regenerates the model catalog; refreshing it is a reviewed source change`,
				);
			}
		}
	}

	// The workflows were only half the surface. The release and rehearsal scripts run
	// the same commands outside any workflow, which is how live regeneration survived
	// in local-release.mjs while this test stayed green.
	for (const path of ["scripts/local-release.mjs", "scripts/release.mjs"]) {
		// Comments legitimately name these commands when explaining that refreshing is a
		// deliberate maintenance step, so inspect executable lines only.
		const code = (await read(path))
			.split("\n")
			.filter((line) => !line.trim().startsWith("//"))
			.join("\n");
		assert.ok(
			!/generate:models|hydrate:model-data/.test(code),
			`${path} regenerates the model catalog; refreshing it is a reviewed source change`,
		);
		assert.ok(!/"npm run build"/.test(code), `${path} runs the live root build; use build:offline`);
	}
});

test("the source archive contains only the requested commit's bytes", async (t) => {
	// Runs the shipped wrapper, not git. A previous version of this test drove
	// `git archive` directly and asserted on the script's text, so a mutation that
	// resolved the commit with `git stash create` kept every assertion green and
	// still archived the dirty working tree.
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const root = await mkdtemp(join(tmpdir(), "source-archive-"));
	t.after(() => rm(root, { force: true, recursive: true }));

	const write = async (relativePath, contents) => {
		await mkdir(dirname(join(root, relativePath)), { recursive: true });
		await writeFile(join(root, relativePath), contents);
	};

	// The smallest tree the wrapper accepts: its required paths, a stub model-data
	// validator, and the catalog file that carries the sentinel.
	const seed = async (sentinel, version) => {
		await write("package.json", `${JSON.stringify({ name: "pi-monorepo", version }, null, "\t")}\n`);
		await write("package-lock.json", "{}\n");
		await write("scripts/build-binaries.sh", "#!/usr/bin/env bash\n");
		await write("packages/ai/src/models.generated.ts", "export const MODELS = {};\n");
		await write("packages/ai/src/image-models.generated.ts", "export const IMAGE_MODELS = {};\n");
		await write("packages/ai/scripts/check-model-data.ts", 'console.log("Generated model data is valid.");\n');
		await write("packages/coding-agent/package.json", `${JSON.stringify({ version }, null, "\t")}\n`);
		await write("packages/coding-agent/src/utils/image-resize-worker.ts", "export {};\n");
		await write("packages/coding-agent/src/core/export-html/template.css", "/* */\n");
		await write("packages/ai/src/providers/data/.manifest.json", `{ "sentinel": "${sentinel}" }\n`);
	};

	await mkdir(join(root, "scripts"), { recursive: true });
	await copyFile(join(repoRoot, "scripts/create-source-archive.sh"), join(root, "scripts/create-source-archive.sh"));
	await chmod(join(root, "scripts/create-source-archive.sh"), 0o755);

	git(root, "init", "-b", "main");
	git(root, "config", "user.email", "release@example.test");
	git(root, "config", "user.name", "Release Test");

	// Three distinct states, so the archive can only match one of them.
	await seed("REQUESTED_REF_SENTINEL", "0.84.0");
	git(root, "add", "-A");
	git(root, "commit", "-m", "Release fractaal-v0.84.0");
	const requestedCommit = git(root, "rev-parse", "HEAD");

	await seed("CURRENT_HEAD_SENTINEL", "0.84.0");
	git(root, "add", "-A");
	git(root, "commit", "-m", "Add [Unreleased] section for next cycle");

	await write("packages/ai/src/providers/data/.manifest.json", '{ "sentinel": "DIRTY_WORKTREE_SENTINEL" }\n');

	const out = join(root, "out", "pi-0.84.0-source.tar.gz");
	const archive = spawnSync(
		join(root, "scripts/create-source-archive.sh"),
		["--version", "0.84.0", "--ref", requestedCommit, "--out", out],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(archive.status, 0, `${archive.stdout}\n${archive.stderr}`);
	// The wrapper still validates the extracted catalog and normalizes the archive.
	assert.match(archive.stdout, /Generated model data is valid\./);

	const extracted = join(root, "extracted");
	await mkdir(extracted, { recursive: true });
	spawnSync("tar", ["-xzf", out, "-C", extracted], { encoding: "utf8" });
	const archivedManifest = await readFile(
		join(extracted, "pi-0.84.0/packages/ai/src/providers/data/.manifest.json"),
		"utf8",
	);

	// Exclusions first, so a wrong commit resolution reports which state it archived
	// rather than the generic "requested sentinel missing".
	assert.ok(!archivedManifest.includes("DIRTY_WORKTREE_SENTINEL"), "archive leaked uncommitted working-tree bytes");
	assert.ok(!archivedManifest.includes("CURRENT_HEAD_SENTINEL"), "archive used current HEAD, not the requested ref");
	assert.match(archivedManifest, /REQUESTED_REF_SENTINEL/);

	// Archiving must not clean or stage the working tree either.
	assert.match(
		await readFile(join(root, "packages/ai/src/providers/data/.manifest.json"), "utf8"),
		/DIRTY_WORKTREE_SENTINEL/,
	);
	assert.match(git(root, "status", "--porcelain"), /^M packages\/ai\/src\/providers\/data\/\.manifest\.json$/m);
});

test("the release workflow pins publication to the verified build commit", async () => {
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const workflow = parseYaml(await readFile(join(repoRoot, ".github/workflows/build-binaries.yml"), "utf8"));
	const build = workflow.jobs.build;
	const publish = workflow.jobs["publish-npm"];

	// build must publish the commit it verified, not just the version.
	assert.match(build.outputs.commit, /steps\.release\.outputs\.commit/);

	// publish-npm must consume it, and must not re-resolve the mutable tag name.
	assert.ok(publish.needs.includes("build"), "publish-npm must depend on build");
	assert.ok(publish.needs.includes("stage-github-release"), "publish-npm must keep the release lifecycle order");
	assert.match(publish.env.RELEASE_COMMIT, /needs\.build\.outputs\.commit/);

	const checkout = publish.steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout"));
	assert.equal(checkout.with.ref, "${{ env.RELEASE_COMMIT }}");

	// ...and must still re-verify the tag against that pinned checkout.
	assert.ok(
		publish.steps.some((step) => String(step.run ?? "").includes("verify-release-source.mjs")),
		"publish-npm must re-run the release source verifier",
	);

	// The live remote check must be the last thing before the first publish side effect.
	const stepIndex = publish.steps.findIndex((step) => String(step.run ?? "").includes("--remote"));
	const publishIndex = publish.steps.findIndex((step) => String(step.run ?? "").includes("publish.mjs"));
	assert.ok(stepIndex !== -1, "publish-npm must verify the live remote tag");
	assert.equal(stepIndex, publishIndex - 1, "the remote tag check must run immediately before publication");
});
