# Research: Release Project for Bunx Installation

**Branch**: `20260405-112827-bunx-release` | **Date**: 2026-04-05

---

## Finding 1 — `private: true` Is The Immediate Publish Blocker

### Evidence

- npm's official `package.json` documentation states that if `"private": true` is set, npm will refuse to publish the package.
- The current repository `package.json` still includes `"private": true`.

### Decision

- **Chosen**: Remove `"private": true` and replace accidental-publish protection with explicit public-package metadata plus controlled publish workflow rules.
- **Rationale**: Keeping `private` makes public release impossible. Publish safety should come from the workflow and registry configuration, not a flag that blocks the feature outright.
- **Alternatives considered**:
  - _Keep `private` and rely only on GitHub release binaries_: Rejected because it does not satisfy the `bunx` install requirement.
  - _Publish manually from a developer machine_: Rejected because it increases credential and consistency risk.

---

## Finding 2 — The Unscoped Package Name `agentsync` Is Already Taken

### Evidence

- Registry query `npm view agentsync name version --json` returned an existing package named `agentsync` at version `0.2.0-alpha.23`.
- npm requires `name` + `version` to form the published package identity.

### Decision

- **Chosen**: Publish under a scoped package identity, `@chrisleekr/agentsync`, and keep the CLI executable name as `agentsync`.
- **Rationale**: A scoped package avoids the naming collision while preserving the product name and the user-facing command.
- **Alternatives considered**:
  - _Find another unscoped package name_: Rejected because it weakens product identity and invites another naming collision.
  - _Rename the CLI binary too_: Rejected because the spec only requires changing the package identity when a release-blocking conflict exists.

---

## Finding 3 — Bunx Supports A Bun-Native Executable Contract

### Evidence

- Bun's official `bunx` docs state that package executables come from the `bin` field.
- The same docs state that Bun respects shebangs by default, including `#!/usr/bin/env node`, and show `#!/usr/bin/env bun` as the way to force Bun runtime execution.
- The current CLI entrypoint, `src/cli.ts`, already starts with `#!/usr/bin/env bun`.
- Production code in `src/commands/daemon.ts` contains Bun-specific runtime detection, which means this repository is not currently promising generic Node runtime compatibility.

### Decision

- **Chosen**: Keep Bun as the supported runtime for the published CLI and emit a published `bin` artifact that retains a Bun shebang.
- **Rationale**: This aligns the release surface with the existing runtime contract instead of pretending the CLI is Node-native when it is not.
- **Alternatives considered**:
  - _Publish a Node-targeted executable as the primary runtime_: Rejected because it over-promises compatibility the repository does not currently guarantee.
  - _Ship `src/cli.ts` directly as the package bin_: Rejected because a dedicated built artifact gives a tighter, more auditable package surface.

---

## Finding 4 — npm Trusted Publishing Is The Best-Fit Publish Mechanism

### Evidence

- npm's official trusted publishing documentation states that trusted publishing uses OIDC, eliminates long-lived tokens, and is supported for GitHub Actions on GitHub-hosted runners.
- The same docs require npm CLI `11.5.1` or later and Node `22.14.0` or later.
- The official GitHub Actions OIDC docs describe short-lived credentials as the preferred security model over stored long-lived secrets.
- The repository already uses GitHub-hosted runners in CI and release workflows.

### Decision

- **Chosen**: Use `npm publish` with GitHub Actions OIDC trusted publishing in the existing release-please workflow.
- **Rationale**: This is the documented, least-secret, registry-supported path for npm publication from GitHub Actions.
- **Alternatives considered**:
  - _Use an `NPM_TOKEN` secret_: Rejected because npm's official guidance prefers trusted publishing over tokens where available.
  - _Use `bun publish` as the primary publish mechanism_: Rejected because the official trusted publishing flow is specified for the npm CLI, and the feature does not require Bun to perform the publish step.

---

## Finding 5 — `actions/cache@v5` Is The Correct Cache Upgrade Here

### Evidence

- The official `actions/cache` repository lists `v5` as the current major release.
- The docs note that `actions/cache@v5` runs on Node 24 and requires a minimum runner version of `2.327.1` for self-hosted runners.
- This repository uses GitHub-hosted `ubuntu-latest` and `macos-latest` runners in the workflows under review.
- `release-please.yml` already uses `actions/cache@v5`, while `ci.yml` still uses `actions/cache@v4`.

### Decision

- **Chosen**: Upgrade the remaining CI workflow cache steps to `actions/cache@v5` so workflow behavior is consistent.
- **Rationale**: The repo is already on hosted runners, so the v5 runner requirement is not a blocker here, and the mixed v4/v5 state adds needless drift.
- **Alternatives considered**:
  - _Leave CI on v4_: Rejected because it preserves avoidable inconsistency with the release workflow.
  - _Replace manual cache steps with unrelated caching behavior_: Rejected because the current Bun cache path is already clear and working.

---

## Finding 6 — Node Tooling Needs Separate Pinning From Bun Runtime Pinning

### Evidence

- The repo already pins Bun via `.bun-version` and uses Bun as the application runtime.
- npm trusted publishing introduces a second toolchain requirement: Node `22.14.0+` and npm `11.5.1+`.
- The official `nvm` documentation supports a project-level `.nvmrc` file and documents that `nvm use` / `nvm install` will use it when present.
- Volta's official documentation states that `volta pin node@...` stores the exact Node version in `package.json` for reproducible project environments.

### Decision

- **Chosen**: Keep `.bun-version` for Bun, and add both `.nvmrc` and a Volta Node pin for the Node publishing toolchain.
- **Rationale**: Bun and Node serve different roles in this repo after npm publishing is introduced. Keeping both pins explicit prevents cross-machine drift without conflating runtime support.
- **Alternatives considered**:
  - _Add only `.nvmrc`_: Rejected because Volta gives a better cross-shell, cross-platform project pin for collaborators who use it.
  - _Use only Volta_: Rejected because `.nvmrc` remains a widely recognized project hint for Node tooling.
  - _Replace Bun pinning with Node pinning_: Rejected because the product runtime is still Bun.

---

## Finding 7 — The Install Command Must Be Documented Around The Scoped Package

### Evidence

- Bun documents `--package` / `-p` for running a binary when the package name differs from the executable name.
- A scoped package identifier like `@chrisleekr/agentsync` differs from the intended CLI command name `agentsync`.

### Decision

- **Chosen**: Document the guaranteed first-run command as `bunx --package @chrisleekr/agentsync agentsync`.
- **Rationale**: This matches Bun's documented invocation pattern and avoids relying on package-manager inference when the package identifier and executable name differ.
- **Alternatives considered**:
  - _Document `bunx agentsync`_: Rejected because the unscoped package name is unavailable.
  - _Assume Bun will always infer the correct scoped package binary without `--package`_: Rejected because the documented form is clearer and lower-risk.
