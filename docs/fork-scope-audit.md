# Fractaal Pi fork scope audit

Status: final local implementation and verification; no push, merge, publication, or deployment.

Target: `/home/benjude/CodeProjects/pi`, branch `fix/fork-release-simplification`, based on `origin/main` at `e72fea0cb`.

## Scope established with Ben

The completed answer record is in [fork-scope-interview-answers.md](fork-scope-interview-answers.md). Ben's interview answers establish:

- Preserve Pi runtime behavior and continue useful upstream syncs.
- Required consumers are the personal Pi CLI and Aria Local Runtime, including Desktop and Cloud Aria Neo.
- npm is the required installation/publication path.
- Linux, macOS, Windows, and Android/Termux remain supported runtime platforms.
- Standalone GitHub binaries and Nix are not current products.
- Other library consumers are not a current requirement.
- Outside-contributor administration is not a current product requirement.
- Publish only packages with real consumers. Retain unused inherited packages without adding fork-specific publication or maintenance work.
- A task saying “fix this and publish” authorizes the agent to commit, push, open and merge the protected-main PR, push the release tag, publish through npm Trusted Publishing, and update local Pi.
- Protected `main` remains in force; the agent automates the PR path rather than bypassing it.

## KEEP

| Area | Evidence / reason |
|---|---|
| Fork runtime changes and behavior tests | Aria and append-only session consumers rely on the native-compaction, continuation, and late-tool contracts recorded in `AGENTS.md`. |
| The eight current published packages | They form the coding-agent runtime closure and are all present in `scripts/fractal-identity.mjs`. |
| Upstream source package names plus the packaging identity transform | Source imports stay merge-compatible while published artifacts resolve their internal edges to `@fractaal/*`. |
| npm Trusted Publishing, provenance, and immutable tag verification | The existing `0.86.1` packages have SLSA provenance; all eight attestations identify the same GitHub workflow and `npm-publish` environment. |
| Protected-main PR and required status check | GitHub ruleset `Protect Fractaal main` is active for `refs/heads/main`, requires a pull request and strict `build-check-test`, permits merge commits only, and has no bypass actors. |
| Published-surface test gate | `npm run test:published` isolates HOME/resources and tests scripts plus only the eight fork-published packages. |

## DELETE / REMOVE FROM THE CURRENT FORK PRODUCT

| Removed surface | Evidence / reason |
|---|---|
| Standalone binary build, source-archive, binary smoke, and GitHub Release machinery | Ben selected npm as the current installation path and explicitly deferred standalone binaries. |
| Nix flake, lockfile, package expression, and release workflow | Ben explicitly deferred Nix; no current consumer requires it. |
| Upstream model-catalog publication/update scripts and workflow | The fork does not own the upstream R2 catalog publication. Local committed model data remains part of builds. |
| Upstream release announcement helpers | No current fork release announcement or pi.dev marker is required. |
| Contributor approval, issue auto-close, triage, issue-analysis, PR gate, and inherited issue templates | Ben does not want community administration for this fork. |
| Binary-sidecar identity CLI mode and tests | No current binary artifact consumes that path; package identity transformation remains for the eight npm packages. |
| Upstream package names in TypeScript examples | The examples are source-sync content and are explicitly marked upstream-sync-only; published SDK documentation uses `@fractaal/*`. |

## RETAINED BUT OUTSIDE CURRENT FORK WORK

The following inherited public packages remain source/build/test content but are not fork-published or part of the release gate until a real consumer appears:

- `pi-client`
- `pi-server`
- `pi-protocol`
- `pi-durable`
- `pi-env`
- `pi-evals`

This is not a claim that their upstream behavior is incorrect. It is a scope boundary for fork publication and release work.

## DEFERRED / ASK

### Full inherited monorepo test suite

The full `./test.sh` was run from the built state. Its package tests passed except for the unchanged `packages/env/test/ssh.test.ts` case `starts the daemon through the login shell only when asked`, which fails locally with `pi-env exited with code 127 before it was ready`.

This test is outside the current fork release gate because `pi-env` has no current fork consumer. It was not repaired or changed. Reopen this item if `pi-env` becomes a supported consumer or if the full inherited suite must become a release blocker again.

### Unused inherited packages

Do not delete their source or tests as part of this cleanup. Revisit publication or maintenance only when a real consumer is identified.

## Verification report

| Check | Result |
|---|---|
| `npm run check` | Passed. |
| `npm run test:published` | Passed: 2,797 tests passed, 50 skipped, using the isolated test harness. |
| `npm run test:scripts` | Passed: 56 tests. |
| `node --test scripts/verify-release-source.test.mjs` | Passed: 14 tests. |
| `node --test scripts/fractal-identity.test.mjs` | Passed: 9 tests. |
| `npm run release:local -- --skip-check --skip-test --out /tmp/pi-local-release-final --force` | Passed against transformed `@fractaal/*` artifacts: the isolated npm consumer installed `@fractaal/pi-coding-agent`, verified SDK/CLI/dependency closure, and reported `0.86.1`. Retained log: `docs/evidence/fork-artifact-smoke.log`. |
| Real `@fractaal/*` artifact rehearsal | Passed both through the normal local smoke and a source-copy rehearsal. All eight transformed packages were packed and a clean consumer verified SDK/CLI/dependency closure. No registry publication. |
| npm provenance | All eight `@fractaal/*@0.86.1` attestations identify `fractaal/pi/.github/workflows/build-binaries.yml`, tag `fractaal-v0.86.1`, and the npm-publish environment. The filename was retained deliberately. |
| Protected-main settings | Verified through GitHub ruleset API: active, PR required, strict `build-check-test`, merge-only, no bypass actors. |

## Changed files

The implementation is recorded in task-scoped local commits ahead of `origin/main` in the isolated worktree. Runtime source under `packages/*/src` was not changed.

Primary changes:

- npm-only publication workflow, retaining the configured workflow filename;
- isolated published-surface test gate;
- npm-only local release smoke;
- removal of unused distribution, catalog publication, contributor, and Nix ceremony;
- fork release policy, package documentation, and contribution guidance alignment;
- removal of dead binary-sidecar identity CLI/tests;
- removal of inherited issue templates and stale contributor guidance;
- this audit record.

No package was published and no remote branch or tag was changed.
