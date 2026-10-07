---
name: release
description: Prepare, publish, verify, and recover Fractaal Pi npm releases. Use for release preparation, local npm smoke tests, trusted publication, and failed release CI.
---

# Releasing Fractaal Pi

Run repository commands from the Pi repository root. This fork publishes only the eight package family consumed by Pi and Aria:

- `@fractaal/pi-telemetry`
- `@fractaal/chord`
- `@fractaal/pi-codemode`
- `@fractaal/pi-mcp`
- `@fractaal/pi-ai`
- `@fractaal/pi-agent-core`
- `@fractaal/pi-tui`
- `@fractaal/pi-coding-agent`

Unused inherited packages remain source and test content but are not fork-published until a real consumer needs them.

Standalone binaries, Nix releases, GitHub Release assets, upstream model-catalog publication, and contributor-management workflows are not current fork products.

## User-authorized release

When Ben explicitly asks to fix and publish:

1. Make the requested change in a task branch and run the relevant behavior-first checks.
2. Run `npm run release:patch` or `npm run release:minor` as appropriate.
3. Push the task branch and open the pull request into protected `main`.
4. Wait for `build-check-test`, merge the pull request using the allowed merge method, and fetch `main`.
5. Run `npm run release:tag -- fractaal-v<version>`.
6. Let `.github/workflows/build-binaries.yml` verify and publish through npm Trusted Publishing/OIDC. The filename is retained because npm Trusted Publishing is configured against it; the workflow no longer builds binaries.
7. Verify the npm package version and update/restart local Pi when the task requires it.

Do not stop for a manual Ben handoff between these steps. Do not publish unrelated work.

## Local npm smoke test

```bash
npm run release:local -- --out /tmp/pi-local-release --force
```

This builds and packs the eight publishable packages, installs them into a clean npm directory outside the repository, starts the npm-installed CLI, and verifies its version and consumer boundary. It does not build standalone binaries or Bun package installs.

## Publication safety

The release workflow must:

- verify that the tag names a release commit reachable from `main`;
- verify that every fork-published package carries the tag version;
- build from the committed model catalog;
- run checks, tests, and the packed npm consumer smoke before publication;
- apply the fork identity only after those checks;
- verify the live remote tag immediately before the first publication side effect;
- publish with npm Trusted Publishing/provenance rather than a stored npm token;
- remain idempotent when a package version was already published.

A failed publication is retried from the same immutable tag after the cause is fixed. Never rerun the version-bump script for a tag that already exists.
