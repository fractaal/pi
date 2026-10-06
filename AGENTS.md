# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Local Work and Release Authority

Work autonomously within the agreed task. Local builds, tests, checks, unpublished package smoke builds, and task-scoped commits are routine engineering work; do not ask Ben for a separate go-ahead.

**Production deployments and package publication require Ben's explicit authorization.** Judge the action by its effects: pushing a tag, merging, or running a workflow that deploys to production or publishes a package crosses that boundary. Preparing and testing unpublished artifacts locally does not. Keep the existing release pipeline and branch protections intact.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- In `packages/coding-agent`, resolve package assets through helpers in `src/config.ts`. Do not use `__dirname` directly; the helpers account for source checkouts, npm installations, and standalone binaries.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before marking work ready. WIP commits may record unfinished or failing work, but must say so; a checkpoint is not a claim of verification. This command does not run tests.
- Run local builds and tests as needed to verify the task. Prefer focused checks and use the offline/non-e2e test paths below; authorization for local work is not a reason to run unrelated or live-provider suites.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Make frequent task-scoped local commits, including honest WIP checkpoints. Do not wait for a separate commit request.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Keep dependency lifecycle scripts disabled by default. Run reviewed setup/build scripts needed for the task without a separate approval; do not enable unreviewed dependency scripts.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/install-lock/` needs regen, run `node scripts/generate-coding-agent-install-lock.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Set it only for task-required, reviewed lockfile or install-lock changes; do not use it to hide unrelated dependency churn.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

For testing pi's interactive mode, load and follow [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md).

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when working on a branch other than `main` or pull request

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

**This fork publishes `@fractaal/pi-ai`, `@fractaal/pi-agent-core`, `@fractaal/pi-tui`, and `@fractaal/pi-coding-agent`** at ordinary stable SemVer on npm's ordinary `latest` tag. There is no `-fractal.N` version suffix and no `fractal` dist-tag. The source tree keeps upstream's `@earendil-works/*` names so upstream merges stay mechanical; `scripts/fractal-identity.mjs` applies the fork identity to the manifests in CI, immediately before publishing, and is the only place that transformation exists. Release tags are `fractaal-vX.Y.Z`, because upstream `v*` tags arrive through merges and share the same Git tag namespace.

1. **Update CHANGELOGs**: review the changes since the previous release and update each affected package's `[Unreleased]` section as part of release preparation. No separate prompt or user-run changelog audit is required.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Before a version exists on npm, add `--skip-bun-install` and apply the fork identity first (`node scripts/fractal-identity.mjs <version>`), then restore the manifests afterwards. The published internal edges are npm aliases (`"@earendil-works/pi-ai": "npm:@fractaal/pi-ai@X"`); npm `overrides` redirect those to the local tarballs, but Bun resolves the alias from the registry regardless and cannot install an unpublished version. The Bun binary smoke at `bun/pi` is unaffected, because it is built from the workspace rather than from tarballs.

   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Prepare the release on a branch**. `main` is protected: pull request required, strict `build-check-test`, force-push and deletion blocked, no bypass. There is no admin override and protection is never relaxed for a release, so the release is prepared on a branch and the tag is pushed afterwards.
   ```bash
   git checkout -b release/v<version> origin/main
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or install-lock diffs the release creates before pushing the branch.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check` and the tests, commits `Release fractaal-vX.Y.Z`, creates the tag locally, adds fresh `## [Unreleased]` changelog sections, and commits `Add [Unreleased] section for next cycle`. It pushes nothing, and it refuses to run on `main`.

4. **Merge the release branch as a normal pull request**, with `build-check-test` green. **Merge it with a merge commit.** Squash and rebase merges create a new commit, which leaves the tag pointing at a commit that is not on `main`; the tag step then refuses to publish, by design. Both the release commit and the next-cycle commit stay reachable on `main`.

5. **Publish — only after Ben explicitly authorizes package publication.** Pushing the release tag starts publication:
   ```bash
   git checkout main && git pull
   npm run release:tag -- fractaal-v<version>
   ```
   This is the irreversible step, so it proves everything first: the working tree is clean, `origin/main` is fetched fresh rather than read from a possibly stale local ref, the tag's commit carries the exact `Release fractaal-vX.Y.Z` subject and that version in every published manifest and is reachable from that fresh `origin/main`, and the remote tag is either absent or already exactly this commit. Rerunning after a successful push is a no-op. A remote tag pointing at a different commit is a hard stop: release tags are immutable, so publish a new version rather than moving one. Use `--dry-run` to verify without pushing.

6. **CI publishes npm packages**: pushing the `fractaal-vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The tag is the only publishable source, and every release output comes from one commit. `build` checks out the tag and `scripts/verify-release-source.mjs` fails the run unless the checked-out commit is the tag target, is reachable from `main`, has the subject `Release fractaal-vX.Y.Z`, and carries that version in every published manifest; `build` then exports that commit. `publish-npm` checks out that exact SHA rather than the tag, and immediately before publishing re-runs the verifier with `--remote`, which asks origin whether the public tag still points at it and fails closed if it moved after checkout. A recovery run reruns the same tag; there is no source-ref override. The `publish-npm` job runs check and test against the ordinary source tree, then applies `scripts/fractal-identity.mjs` and publishes through npm trusted publishing over GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, WebAuthn, or `NPM_TOKEN` is required. Publishing four packages by hand is retired.

7. **If CI publish fails**: inspect the failed `publish-npm` job. The publish helper is idempotent and skips package versions already present on npm, so rerun the tag workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## Intentional Divergences from Upstream

Upstream merges must preserve these behaviors. When an upstream test asserts the opposite, adapt that test to the fork contract instead of dropping the behavior. Revisit a divergence only when its reason no longer holds.

- **`Agent.continue()` runs queued work on an empty or system-only transcript** (`packages/agent`). The fork's OpenAI-native compaction keeps context in a provider-owned checkpoint, so afterwards the generic transcript can be empty while real context exists. Upstream throws `No messages to continue from` there. The fork runs queued steering, then queued follow-ups, and throws only when nothing is queued. Without this, a message queued during native compaction never runs and its session stalls (Symphony Desktop incident, 2026-08-06; `459d08460`).
- **A length-stopped response is continued, not replayed** (`packages/coding-agent`). When threshold compaction follows `stopReason: "length"`, the fork replays only if no visible text was emitted. With partial visible text it keeps that text and has the model continue from the cutoff. Upstream omits the truncated response from context and regenerates the answer. Hosts with append-only transcripts, such as Symphony chats mirrored to Discord or Slack, cannot retract text already delivered, so a replay shows the fragment followed by a full repeated answer. Contract accepted by Ben on 2026-08-10 (Symphony session `1536221732854308915`; `3006d0dff`).

## Policy Changes

When Ben explicitly changes this fork's workflow policy, that instruction is the authorization; do not ask him to repeat it. Reconcile the owning guidance instead of leaving conflicting rules behind. Ask when the intended scope or release consequences are genuinely unclear.
