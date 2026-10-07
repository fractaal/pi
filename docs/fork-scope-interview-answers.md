# Fractaal Pi fork interview answers

Transcribed from Ben's scope interview. These decisions establish scope; they do not authorize publication by themselves.

## Product scope

Fractaal Pi remains Pi, regularly updated from upstream. The cleanup is about release, CI, and repository ceremony, not re-evaluating or changing Pi runtime behavior.

## Required consumers

- Personal Pi CLI: required.
- Aria Local Runtime, including Symphony Desktop and Cloud Aria Neo: required.
- Other library consumers: not currently required.
- Outside users installing the fork: acceptable when they use the normal Pi CLI, but the fork must not encode user- or machine-specific assumptions.

## Installation and platforms

- npm installation and library dependencies: required.
- Standalone GitHub binaries: not now.
- Nix installation: not now.
- Required runtime platforms: Linux, macOS, Windows, Android/Termux.

## Runtime behavior

Preserve existing Pi behavior and focus on ceremony. Do not add more Pi behavior changes as part of this cleanup.

## Upstream relationship

Stay close to upstream and regularly merge useful updates. Retain the inherited monorepo source as upstream-sync surface, but do not publish or maintain unused packages as fork products without a real consumer.

## Publication scope

Publish only packages with real current consumers. The current eight-package fork family remains:

- `@fractaal/pi-telemetry`
- `@fractaal/chord`
- `@fractaal/pi-codemode`
- `@fractaal/pi-mcp`
- `@fractaal/pi-ai`
- `@fractaal/pi-agent-core`
- `@fractaal/pi-tui`
- `@fractaal/pi-coding-agent`

The inherited `pi-client`, `pi-server`, `pi-protocol`, `pi-durable`, `pi-env`, and `pi-evals` packages remain source/test content but are not current fork-published products.

## Autonomous release authority

When Ben says “fix this and publish,” the agent may commit, push, open and merge the protected-main PR after required checks, push the release tag, let GitHub Actions publish through npm Trusted Publishing, and update the local Pi installation.

This does not authorize unrelated background publication or weakening branch protections.

## Repository administration

Outside-contributor administration is not a current product requirement. Do not retain or reintroduce upstream contributor approval, issue auto-close, triage, issue-analysis, or related workflows/templates without a new scope decision.
