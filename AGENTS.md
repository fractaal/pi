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

**Production deployments still require Ben's explicit authorization.** For this fork, a task instruction such as "fix this and publish" authorizes the agent to commit, push, open and merge the protected-main PR after required checks pass, push the release tag, publish the fork packages through the existing trusted-publishing workflow, and update the local Pi installation. Do not publish changes from unrelated tasks or from unrequested background work. Keep protected main and the npm environment boundary intact.

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
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For the full inherited monorepo suite, run `./test.sh` from the repo root. The fork's release and required CI surface uses `npm run test:published`, which covers scripts and the eight packages published under `@fractaal`. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
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

**Lockstep versioning**: all workspace packages keep the upstream lockstep version so regular upstream merges remain mechanical. The fork publishes only the eight packages with current consumers: @fractaal/pi-telemetry, @fractaal/chord, @fractaal/pi-codemode, @fractaal/pi-mcp, @fractaal/pi-ai, @fractaal/pi-agent-core, @fractaal/pi-tui, and @fractaal/pi-coding-agent. Unused inherited packages remain source and test content but are not fork-published until a real consumer needs them.

The source tree keeps upstream's @earendil-works/* names so upstream merges stay mechanical. scripts/fractal-identity.mjs applies the @fractaal/* identity only to the artifacts being published, pins their internal versions, and is the single packaging-boundary transformation. Release tags are fractaal-vX.Y.Z and npm uses the ordinary latest tag.

Standalone binaries, Nix releases, GitHub Release assets, upstream model-catalog publication, and contributor-management workflows are not current fork products. Do not reintroduce them from upstream without a new scope decision.

### Normal autonomous release path

When Ben explicitly asks to fix and publish:

1. Make the requested change in a task branch and run the relevant behavior-first checks.
2. Run npm run release:patch or npm run release:minor as appropriate. This updates the lockstep workspace version, changelogs, committed model data checks, the full local checks, tests, and the packed npm consumer check.
3. Push the task branch and open the pull request into protected main.
4. Wait for required checks, merge the pull request with the normal repository merge policy, and fetch main.
5. Run npm run release:tag -- fractaal-v<version>. This verifies the release commit is reachable from current origin/main and pushes the immutable tag.
6. The tag workflow checks the tag, builds and tests the npm package family, applies the fork identity, verifies the live tag immediately before publication, and publishes through npm trusted publishing/OIDC.
7. Verify the new npm version and restart or update local Pi when the task requires it.

This is one user-authorized operation even though protected-main and npm's deployment environment still enforce their boundaries. There is no manual Ben handoff between these steps.

### Local release smoke

The local rehearsal is intentionally limited to the product we ship:

npm run release:local -- --out /tmp/pi-local-release --force

It must build and pack the eight publishable packages, install them into a clean directory outside the repository, start the npm-installed CLI, report the expected version, and run the intended offline/provider smoke checks. It does not build standalone binaries or Bun package installs.

### Publication safety

The release workflow must:

- verify that the tag names a release commit reachable from main;
- verify that every fork-published package carries the tag version;
- run checks, tests, and the packed npm consumer smoke before publication;
- apply the fork identity only after those checks;
- verify the live remote tag immediately before the first publication side effect;
- publish with npm trusted publishing/provenance rather than a stored npm token;
- remain idempotent when a package version was already published.

A failed publication is retried from the same immutable tag after the cause is fixed. Do not create a second version merely because a workflow failed after some packages were already published.

main remains protected. The agent may automate the pull request and merge after required checks, but branch protection and the npm deployment environment are not weakened.

## Intentional Divergences from Upstream


Upstream merges must preserve these behaviors. When an upstream test asserts the opposite, adapt that test to the fork contract instead of dropping the behavior. Revisit a divergence only when its reason no longer holds.

- **`Agent.continue()` runs queued work on an empty or system-only transcript** (`packages/agent`). The fork's OpenAI-native compaction keeps context in a provider-owned checkpoint, so afterwards the generic transcript can be empty while real context exists. Upstream throws `No messages to continue from` there. The fork runs queued steering, then queued follow-ups, and throws only when nothing is queued. Without this, a message queued during native compaction never runs and its session stalls (Symphony Desktop incident, 2026-08-06; `459d08460`).
- **A length-stopped response is continued, not replayed** (`packages/coding-agent`). When threshold compaction follows `stopReason: "length"`, the fork replays only if no visible text was emitted. With partial visible text it keeps that text and has the model continue from the cutoff. Upstream omits the truncated response from context and regenerates the answer. Hosts with append-only transcripts, such as Symphony chats mirrored to Discord or Slack, cannot retract text already delivered, so a replay shows the fragment followed by a full repeated answer. Contract accepted by Ben on 2026-08-10 (Symphony session `1536221732854308915`; `3006d0dff`).
- **A call to a tool that became available during the turn resolves instead of failing as not found** (`packages/agent`, `packages/coding-agent`). `prepareToolCall` upstream resolves a call only against the turn's tool snapshot. pi-claude-bridge exposes MCP tools through Claude Code's native ToolSearch: Claude loads a deferred tool and calls it in the same round, and the bridge calls `pi.setActiveTools` when the call arrives, so the call used to fail with `Tool X not found`. The fork adds an optional `resolveTool(name)` loop hook that is consulted only when the name is not in the snapshot. `AgentSession` resolves a tool that is active now, or a registered `deferred` or `codemode` tool, which it also activates like a `tool_search` load so the next request declares it. `hidden` tools, inactive `direct` tools and unknown names still return not found. The resolved call goes through the same argument validation, `beforeToolCall`, `tool_call` hooks and permission gates. The call precedes its `toolsAdded` message in the transcript; replay for Anthropic, OpenAI Responses and Codex handles that order. A candidate to propose upstream.

## Policy Changes

When Ben explicitly changes this fork's workflow policy, that instruction is the authorization; do not ask him to repeat it. Reconcile the owning guidance instead of leaving conflicting rules behind. Ask when the intended scope or release consequences are genuinely unclear.
