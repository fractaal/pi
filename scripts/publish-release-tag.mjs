#!/usr/bin/env node
/**
 * Push the immutable release tag, after the release commit is on main.
 *
 * `main` is protected: pull request required, strict checks, no bypass. So a release
 * is two operator steps rather than one. `npm run release:<bump>` prepares the
 * release and next-cycle commits on a branch and stops; that branch goes through a
 * normal pull request; then this pushes the tag, which is what the OIDC workflow
 * publishes from.
 *
 * The tag is the release's point of no return, so everything is proven immediately
 * before it and nothing is repaired afterwards:
 *
 *   - the working tree is clean,
 *   - `origin/main` is fetched fresh rather than trusted from a local ref,
 *   - the local tag's commit carries the exact release subject and versions and is
 *     reachable from that fresh `origin/main`,
 *   - the remote tag is absent, or already points at exactly this commit.
 *
 * A remote tag pointing somewhere else is a hard stop. There is deliberately no
 * force-push or retag path: a published tag is immutable, and moving it would
 * detach the artifacts the workflow already built from it.
 *
 *   node scripts/publish-release-tag.mjs <fractaal-vX.Y.Z> [--dry-run]
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseTag, resolveTagTarget, verifyReleaseCommit } from "./verify-release-source.mjs";

const MAIN_BRANCH = "main";

function git(repoRoot, args) {
	const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
	return {
		ok: result.status === 0,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
	};
}

function gitOrThrow(repoRoot, args, description) {
	const result = git(repoRoot, args);
	if (!result.ok) {
		throw new Error(`${description} failed: git ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout;
}

/** Peeled commit for an annotated tag, direct target for a lightweight one. */
export function readRemoteTagCommit(repoRoot, tag) {
	const listed = git(repoRoot, ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
	if (!listed.ok) {
		throw new Error(`Cannot read the remote release tag ${tag}, so publication cannot be gated.\n${listed.stderr}`);
	}

	const targets = new Map();
	for (const line of listed.stdout.split("\n")) {
		const [sha, ref] = line.trim().split(/\s+/);
		if (!sha || !ref) continue;
		if (ref === `refs/tags/${tag}` || ref === `refs/tags/${tag}^{}`) targets.set(ref, sha);
	}
	return targets.get(`refs/tags/${tag}^{}`) ?? targets.get(`refs/tags/${tag}`);
}

export function publishReleaseTag(repoRoot, tag, options = {}) {
	parseReleaseTag(tag);

	const status = gitOrThrow(repoRoot, ["status", "--porcelain"], "Reading the working tree status");
	if (status !== "") {
		throw new Error(`Working tree is not clean, so the release state cannot be trusted:\n${status}`);
	}

	// Ancestry must be judged against the branch as it is now, not a local ref that
	// may predate the merge, or the merge of something else entirely.
	gitOrThrow(
		repoRoot,
		["fetch", "--no-tags", "origin", `+refs/heads/${MAIN_BRANCH}:refs/remotes/origin/${MAIN_BRANCH}`],
		`Fetching ${MAIN_BRANCH}`,
	);

	const commit = resolveTagTarget(repoRoot, tag);
	const { version } = verifyReleaseCommit(repoRoot, tag, commit);

	const remoteCommit = readRemoteTagCommit(repoRoot, tag);
	if (remoteCommit === commit) {
		return { version, commit, pushed: false, reason: "already published" };
	}
	if (remoteCommit) {
		throw new Error(
			`Remote tag ${tag} already points at ${remoteCommit}, not ${commit}. ` +
				`Release tags are immutable; publish a new version rather than moving it.`,
		);
	}

	if (options.dryRun) {
		return { version, commit, pushed: false, reason: "dry run" };
	}

	// Push the commit that was actually verified, not the local tag by name. The local
	// tag is a mutable ref: between verification and this line it can move, and pushing
	// it by name would publish whatever it points at now. A remote tag is immutable, so
	// noticing afterwards is too late.
	//
	// Still an ordinary non-force create, so a tag created concurrently on the remote
	// makes this fail atomically rather than overwriting it.
	gitOrThrow(repoRoot, ["push", "origin", `${commit}:refs/tags/${tag}`], `Pushing ${tag}`);

	const pushedCommit = readRemoteTagCommit(repoRoot, tag);
	if (pushedCommit !== commit) {
		throw new Error(`Pushed ${tag} but origin reports ${pushedCommit ?? "no tag"}, expected ${commit}.`);
	}

	return { version, commit, pushed: true };
}

const isDirectInvocation = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectInvocation) {
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const tag = process.argv[2];
	const dryRun = process.argv.includes("--dry-run");
	try {
		const result = publishReleaseTag(repoRoot, tag, { dryRun });
		if (result.pushed) {
			console.log(`Pushed ${tag} at ${result.commit}; the release workflow publishes ${result.version} from it.`);
		} else {
			console.log(`${tag} verified at ${result.commit} (${result.reason}); nothing pushed.`);
		}
	} catch (error) {
		console.error(String(error.message ?? error));
		console.error("usage: node scripts/publish-release-tag.mjs <fractaal-vX.Y.Z> [--dry-run]");
		process.exit(1);
	}
}
