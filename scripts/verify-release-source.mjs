#!/usr/bin/env node
/**
 * Bind a release run to the exact commit the release tag names.
 *
 * The publishing job holds an OIDC identity, so whatever it checks out is what npm
 * will trust. Validating the tag's spelling is not enough: the run must prove the
 * working tree is the immutable tag target, that the target is a release commit on
 * `main`, and that its package versions are the version being published. Recovery
 * reruns therefore rebuild the same tag rather than substituting a source ref.
 *
 * A tag is a mutable ref, so proving this once is not enough either. The build job
 * exports the commit it verified and later jobs check out that SHA; rerunning this
 * against the pinned checkout then fails closed if the tag has since moved, even if
 * it moved to another commit that would independently verify.
 *
 * Fails closed. Anything it cannot prove is an error, never a warning.
 *
 *   node scripts/verify-release-source.mjs <fractaal-vX.Y.Z>
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLISHABLE_PACKAGES, RELEASE_TAG_PREFIX } from "./fractal-identity.mjs";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
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

export function parseReleaseTag(tag) {
	const version = typeof tag === "string" && tag.startsWith(RELEASE_TAG_PREFIX) ? tag.slice(RELEASE_TAG_PREFIX.length) : "";
	if (!VERSION_PATTERN.test(version)) {
		throw new Error(`Tag ${JSON.stringify(tag)} is not a fork release tag (expected ${RELEASE_TAG_PREFIX}X.Y.Z).`);
	}
	return version;
}

/**
 * Resolve the commit `main` points at. A tag checkout does not always bring the
 * branch with it, so fetch once if it is missing, and fail closed if reachability
 * still cannot be established rather than skipping the check.
 */
function resolveMainCommit(repoRoot) {
	for (const ref of [`refs/remotes/origin/${MAIN_BRANCH}`, `refs/heads/${MAIN_BRANCH}`]) {
		const resolved = git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
		if (resolved.ok && resolved.stdout) return resolved.stdout;
	}

	const fetched = git(repoRoot, [
		"fetch",
		"--no-tags",
		"origin",
		`+refs/heads/${MAIN_BRANCH}:refs/remotes/origin/${MAIN_BRANCH}`,
	]);
	if (fetched.ok) {
		const resolved = git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${MAIN_BRANCH}^{commit}`]);
		if (resolved.ok && resolved.stdout) return resolved.stdout;
	}

	throw new Error(
		`Cannot resolve ${MAIN_BRANCH}, so release-commit reachability cannot be proven. ` +
			`Check out with full history (fetch-depth: 0).`,
	);
}

export function verifyReleaseSource(repoRoot, tag) {
	const version = parseReleaseTag(tag);

	const head = gitOrThrow(repoRoot, ["rev-parse", "HEAD^{commit}"], "Resolving HEAD");
	const tagTarget = git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
	if (!tagTarget.ok || !tagTarget.stdout) {
		throw new Error(`Release tag ${tag} does not exist in this checkout.`);
	}
	if (tagTarget.stdout !== head) {
		throw new Error(
			`Checked-out commit ${head} is not the ${tag} target ${tagTarget.stdout}. ` +
				`Release runs build the tag itself; recovery reruns the same tag.`,
		);
	}

	const mainCommit = resolveMainCommit(repoRoot);
	const reachable = git(repoRoot, ["merge-base", "--is-ancestor", head, mainCommit]);
	if (!reachable.ok) {
		throw new Error(`Release commit ${head} is not reachable from ${MAIN_BRANCH} (${mainCommit}).`);
	}

	const subject = gitOrThrow(repoRoot, ["log", "-1", "--format=%s", head], "Reading the release commit subject");
	const expectedSubject = `Release ${tag}`;
	if (subject !== expectedSubject) {
		throw new Error(
			`Release commit ${head} has subject ${JSON.stringify(subject)}, expected ${JSON.stringify(expectedSubject)}.`,
		);
	}

	for (const pkg of PUBLISHABLE_PACKAGES) {
		const manifestPath = join(repoRoot, pkg.directory, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (manifest.version !== version) {
			throw new Error(`${pkg.directory} is at version ${manifest.version}, expected ${version} for ${tag}.`);
		}
	}

	return { version, commit: head };
}

/**
 * Compare the *live* remote tag to the pinned commit.
 *
 * `actions/checkout` fetches a tag snapshot once. Everything after that reads a
 * local ref that no longer tracks the public one, so a tag moved after checkout
 * leaves the local snapshot stale and every local check still passes. Publication
 * is the moment that matters, so ask the remote directly.
 *
 * Handles both tag forms: `git ls-remote` reports an annotated tag's own object
 * under `refs/tags/<tag>` and the commit it points at under `refs/tags/<tag>^{}`,
 * while this repository's release script creates lightweight tags that report only
 * the direct line. Prefer the peeled commit when present.
 */
export function verifyRemoteReleaseTag(repoRoot, tag, expectedCommit) {
	const listed = git(repoRoot, ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
	if (!listed.ok) {
		throw new Error(`Cannot read the remote release tag ${tag}, so publication cannot be bound to it.\n${listed.stderr}`);
	}

	const targets = new Map();
	for (const line of listed.stdout.split("\n")) {
		const [sha, ref] = line.trim().split(/\s+/);
		if (!sha || !ref) continue;
		if (ref === `refs/tags/${tag}` || ref === `refs/tags/${tag}^{}`) {
			targets.set(ref, sha);
		}
	}

	const remoteCommit = targets.get(`refs/tags/${tag}^{}`) ?? targets.get(`refs/tags/${tag}`);
	if (!remoteCommit) {
		throw new Error(`Release tag ${tag} does not exist on origin.`);
	}
	if (remoteCommit !== expectedCommit) {
		throw new Error(
			`Remote release tag ${tag} points at ${remoteCommit}, but publication is pinned to ${expectedCommit}. ` +
				`The tag moved after this run started; refusing to publish.`,
		);
	}

	return { commit: remoteCommit };
}

const isDirectInvocation = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectInvocation) {
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const tag = process.argv[2];
	const checkRemote = process.argv.includes("--remote");
	try {
		const { version, commit } = verifyReleaseSource(repoRoot, tag);
		if (checkRemote) {
			verifyRemoteReleaseTag(repoRoot, tag, commit);
			console.log(`Remote release tag verified: ${tag} still points at ${commit}`);
		}
		console.log(`Release source verified: ${tag} at ${commit} (version ${version})`);
		if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `RELEASE_VERSION=${version}\n`);
		// Later jobs consume `commit` and check out that immutable SHA instead of
		// resolving the mutable tag name again, so every release output comes from
		// the one commit this job verified.
		if (process.env.GITHUB_OUTPUT) {
			appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ncommit=${commit}\n`);
		}
	} catch (error) {
		console.error(`::error::${String(error.message ?? error)}`);
		process.exit(1);
	}
}
