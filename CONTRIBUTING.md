# Contributing to Fractaal Pi

Fractaal Pi is maintained as Ben's fork and as the runtime dependency for Pi and Aria. It does not run upstream's contributor approval, issue auto-close, triage, or issue-analysis program.

## Before changing code

- Read `AGENTS.md`.
- Keep runtime changes scoped to a demonstrated consumer contract.
- Prefer an extension or package change over adding behavior to the core.
- Run `npm run check` and the relevant behavior-first tests.
- For release work, use `npm run test:published` and the npm-only local release smoke.

## Pull requests

`main` is protected. Changes merge through a pull request after the required `build-check-test` status succeeds. The repository ruleset allows merge commits and does not grant bypass actors.

When Ben says to fix and publish, the authorized agent may prepare and merge the protected-main PR, push the immutable release tag, let GitHub Actions publish through npm Trusted Publishing, and update the local Pi installation. Do not publish unrelated work or publish from an unrequested background task.

## Scope

The fork currently publishes only packages with real consumers. Inherited packages may remain in the source tree and upstream-sync surface without becoming fork-published products until a consumer requires them.
