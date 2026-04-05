# Implementation Plan: Release Project for Bunx Installation

**Branch**: `20260405-112827-bunx-release` | **Date**: 2026-04-05 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/20260405-112827-bunx-release/spec.md`

## Summary

Publish AgentSync as an installable npm package for Bun users by removing the current publish blocker,
choosing a scoped package identity that avoids the already-taken `agentsync` name, emitting a Bun-runtime
CLI bundle for the package `bin`, adding OIDC-only npm trusted publishing to the existing release-please
workflow, upgrading the remaining CI cache usage to `actions/cache@v5`, pinning the Node publishing
toolchain with `.nvmrc` plus Volta, and updating user, contributor, and maintainer documentation to match
the shipped release path.

## Technical Context

**Language/Version**: TypeScript 6.0.0 (strict) with Bun 1.3.9 runtime; Node 22.14.0+ and npm 11.5.1+ for trusted publishing  
**Primary Dependencies**: Bun 1.3.9, `citty`, `simple-git`, `zod`, release-please, GitHub Actions, npm registry trusted publishing via OIDC  
**Storage**: N/A for runtime data; repository files, GitHub Releases, and npm registry package metadata  
**Testing**: `bun test`, `bun run check`, plus packaging smoke validation using `npm pack` metadata and tarball checks  
**Target Platform**: GitHub-hosted `ubuntu-latest` and `macos-latest` runners; Bun users on macOS, Linux, and Windows for `bunx` execution
**Project Type**: Bun-native CLI and daemon with GitHub release binaries and npm package distribution  
**Performance Goals**: Local packaging validation under 60 seconds; publish validation keeps the release workflow within 5 minutes after release creation  
**Constraints**: Preserve Bun-native runtime semantics, require GitHub OIDC trusted publishing, forbid long-lived npm publish tokens, keep install docs honest about Bun as a prerequisite, and upgrade to `actions/cache@v5` only on supported runners  
**Scale/Scope**: One package manifest, two workflow files, one new Node toolchain pin, four documentation files, one packaging-focused automated validation path, and one external release contract

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

### Principle I — Security-First Credential Handling

**Status: PASS** — This feature does not alter encrypted sync data, but it does introduce a new publish credential
surface. The design requires npm trusted publishing over GitHub OIDC and explicitly forbids long-lived npm write
tokens, which is stronger than the current baseline. Package contents will be constrained through `files` so local
or secret-bearing repository material is not shipped accidentally.

### Principle II — Test Coverage (NON-NEGOTIABLE)

**Status: PASS** — The feature adds a new public release surface and therefore needs automated validation. The design
adds packaging smoke checks under `bun test` to verify publish blockers are removed, the tarball contains the
expected `bin`, package metadata stays aligned with CLI output, and unintended files are excluded.

### Principle III — Cross-Platform Daemon Reliability

**Status: PASS** — The plan preserves the existing Bun-native runtime contract and does not claim direct Node runtime
support. Documentation will explicitly call out Bun as a prerequisite for `bunx`, which keeps supported platform
expectations clear for macOS, Linux, and Windows users.

### Principle IV — Code Quality with Biome

**Status: PASS** — The work stays within the existing toolchain. No new lint or formatting system is introduced.
Workflow updates keep least-privilege permissions, and any data that crosses a trust boundary continues to use the
existing typed configuration patterns already established in the repo.

### Principle V — JSDoc Documentation Standards

**Status: PASS** — No new exported runtime API is required by the feature. If implementation introduces exported
helpers to support package validation or workflow metadata handling, concise JSDoc must be added in the same change.

### Post-Design Re-check

All principles remain satisfied after Phase 1 design. No constitution violations require complexity tracking.

## Project Structure

### Documentation (this feature)

```text
specs/20260405-112827-bunx-release/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── release-surface.md
└── tasks.md
```

### Source Code (repository root)

```text
.github/
└── workflows/
    ├── ci.yml                     # upgrade remaining cache steps to actions/cache@v5 and keep validation consistent
    └── release-please.yml         # add OIDC-only npm publish job

package.json                       # public package metadata, scoped publish identity, bin/files, Volta pin, build scripts
.nvmrc                             # exact Node version for publish tooling across machines
README.md                          # released-user bunx path plus contributor path separation
docs/
├── development.md                 # Bun runtime vs Node publish toolchain expectations
├── command-reference.md           # supported install, verification, and command usage path
└── maintenance.md                 # maintainer release workflow and OIDC publish upkeep

src/
├── cli.ts                         # source entrypoint remains Bun-native
└── commands/__tests__/
  ├── packaging.test.ts          # new packaging smoke validation under bun test
  └── release-workflow.test.ts   # static workflow validation for OIDC publish configuration
```

**Structure Decision**: Single-project CLI repository. The feature is packaging-, workflow-, and documentation-focused,
so changes stay in the existing manifest, workflow, docs, and test paths rather than adding new runtime modules.

## Complexity Tracking

No constitution violations. No complexity justifications required.

---

## Phase 0 — Research Summary

All research is complete. See [research.md](./research.md) for full findings. Key decisions:

| Topic                       | Decision                                                                                              | Why                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Public package identity     | Publish under a scoped package, `@chrisleekr/agentsync`, while keeping the CLI bin name `agentsync`   | The unscoped `agentsync` name is already taken on npm                                                     |
| Bunx install command        | Document the guaranteed command as `bunx --package @chrisleekr/agentsync agentsync`                   | Bun documents `--package` for cases where the binary name differs from the package identifier             |
| Published executable format | Build a Bun-runtime JS bundle to `dist/cli.js` with a Bun shebang and set that as the published `bin` | Bunx respects shebangs, and the repo is Bun-native rather than Node-native                                |
| Publish mechanism           | Use `npm publish` with npm trusted publishing over GitHub Actions OIDC                                | npm officially documents trusted publishing for GitHub Actions with `id-token: write` and npm CLI 11.5.1+ |
| Credential policy           | Require OIDC-only publish credentials and forbid long-lived npm write tokens                          | Matches the clarified spec and reduces standing secret risk                                               |
| Release information surface | Use the GitHub Release created by release-please as the canonical source for version and change notes | Satisfies the spec's release-information requirement without inventing a second changelog system          |
| Node toolchain pinning      | Add `.nvmrc` and a `volta` pin in `package.json` for the Node version used by publishing              | `.nvmrc` is widely interoperable, and Volta provides reproducible per-project Node switching              |
| Cache action upgrade        | Upgrade CI cache usage from `actions/cache@v4` to `actions/cache@v5`                                  | The repo already uses GitHub-hosted runners, and v5 is the current documented release                     |
| Documentation scope         | Update `README.md`, `docs/development.md`, `docs/command-reference.md`, and `docs/maintenance.md`     | The clarified spec separates user, contributor, and maintainer concerns explicitly                        |

---

## Phase 1 — Design

### Interface Contracts

See [contracts/release-surface.md](./contracts/release-surface.md).

This feature changes external user-facing and maintainer-facing contracts:

- npm package identity and metadata
- `bunx` install and verification command surface
- GitHub Actions release workflow permissions and publish sequence
- release information discovery for installed versions and change notes
- documentation promises for users, contributors, and maintainers
- cross-machine Node toolchain pinning expectations for contributors

### Data Model

See [data-model.md](./data-model.md).

The design model centers on persisted release-surface artifacts rather than application runtime data:

- package manifest
- published CLI entry
- trusted publish job
- workflow configuration validation
- toolchain pins
- packaging smoke validation
- release information surface
- documentation surface

### Quickstart

See [quickstart.md](./quickstart.md) for the implementation and verification order.

---

## Phase 2 — Implementation Plan

### Overview

Implementation is split into five workstreams so package identity, publish security, validation, and documentation
can evolve independently while still landing as one release feature.

```text
Phase A: Package identity and metadata
Phase B: Published CLI bundle and packaging validation
Phase C: Release workflow and trusted publishing
Phase D: Contributor toolchain pinning and documentation
Phase E: End-to-end verification and release readiness
```

### Phase A — Package Identity And Metadata

**Goal**: Convert the project from unpublished/private metadata to a public, installable package definition.

**Files modified**:

1. `package.json`
2. optionally `.npmignore` only if `files` cannot express the desired package surface cleanly

**Changes**:

- Remove `private: true`, which npm refuses to publish.
- Change the package `name` from unscoped `agentsync` to a scoped public identifier such as `@chrisleekr/agentsync` because the unscoped name is already taken.
- Keep the CLI command name as `agentsync` via the `bin` field.
- Add or normalize metadata required for a public package listing:
  - `description`
  - `keywords`
  - `repository` in full-object form
  - `homepage`
  - `bugs`
  - `publishConfig.access = "public"`
- Restrict the publish surface with `files` so only the built CLI bundle and required top-level docs and license ship.

**Explicit non-goals**:

- Do not promise direct Node runtime support in package metadata.
- Do not treat npm publication as complete unless the install path is documented and validated.

### Phase B — Published CLI Bundle And Packaging Validation

**Goal**: Produce an npm package whose `bin` executes correctly under Bun and can be validated before release.

**Files modified**:

1. `package.json`
2. `src/cli.ts` only if a shebang or entrypoint adaptation is needed
3. `src/commands/__tests__/packaging.test.ts` (new)

**Changes**:

- Add a dedicated package-build script, such as `build:package`, that emits `dist/cli.js` from `src/cli.ts`.
- Build for the Bun runtime rather than Node runtime because the repository already assumes Bun execution and `bunx` respects shebangs.
- Ensure the published `bin` target is a concrete file in the tarball, not a source-only placeholder.
- Add a packaging smoke test under `bun test` that validates:
  - the package is publishable
  - the tarball includes the configured `bin` target
  - the package metadata and CLI version stay aligned
  - the package contents exclude unintended files

**Alternatives rejected**:

- Publishing `src/cli.ts` directly as the `bin`: works in principle for Bun, but ships more source surface than necessary and makes package-shape verification noisier.
- Publishing a Node-targeted bundle as the primary runtime: rejected because the product is Bun-native and already contains Bun-specific runtime assumptions.

### Phase C — Release Workflow And Trusted Publishing

**Goal**: Extend the existing release-please flow so a created release also publishes the npm package through OIDC.

**Files modified**:

1. `.github/workflows/release-please.yml`
2. `.github/workflows/ci.yml`
3. `src/commands/__tests__/release-workflow.test.ts` (new)

**Changes**:

- Add or extend a publish job in `release-please.yml` that runs only for actual release creation events.
- Use `actions/setup-node` with an exact Node version that satisfies npm trusted publishing requirements.
- Upgrade npm in the publish job if the runner’s bundled npm is too old for trusted publishing.
- Grant only the permissions needed for publish, including `id-token: write` and `contents: read`.
- Publish with `npm publish` through trusted publishing on GitHub-hosted runners only.
- Explicitly avoid `NPM_TOKEN` or equivalent long-lived publish secrets.
- Upgrade remaining CI cache usage from `actions/cache@v4` to `actions/cache@v5` for consistency with the release workflow.
- Add a static workflow-validation test under `bun test` that inspects `release-please.yml` for GitHub-hosted runner use, `id-token: write`, `contents: read`, required Node/npm versions, and the absence of token-based publish credentials.

**Security checks**:

- The workflow must fail closed if OIDC trusted publishing is unavailable.
- No fallback path using stored npm write credentials is allowed by the spec.
- The workflow filename registered with npm must match the actual workflow file exactly.

### Phase D — Contributor Toolchain Pinning And Documentation

**Goal**: Make the supported user, contributor, and maintainer workflows explicit and reproducible across machines.

**Files modified**:

1. `.nvmrc`
2. `package.json`
3. `README.md`
4. `docs/development.md`
5. `docs/command-reference.md`
6. `docs/maintenance.md`

**Changes**:

- Add `.nvmrc` with the Node version required for npm trusted publishing.
- Add a matching `volta.node` pin in `package.json`.
- Keep `.bun-version` as the Bun runtime pin.
- Update `README.md` to separate released-user `bunx` usage from contributor setup from source.
- Update `docs/development.md` to explain why the repo pins both Bun and Node and how contributors should use them.
- Update `docs/command-reference.md` to document:
  - the supported `bunx --package @chrisleekr/agentsync agentsync` install path
  - prerequisites and supported environments
  - first-run verification
  - user-facing command usage expectations
- Update `README.md` and `docs/command-reference.md` to tell users where to see the installed version and what changed in that release by linking to the canonical GitHub Release record.
- Update `docs/maintenance.md` to document:
  - OIDC-only trusted publishing
  - publish job permissions and prerequisites
  - release maintenance steps needed to keep the public install path accurate

**Documentation rule**:

- Draft documentation updates may be prepared on the feature branch, but final merged user-facing wording must not claim supported `bunx` installation until Phase E validation succeeds.
- No file may claim that long-lived npm tokens are a supported publish path for this feature.

### Phase E — End-To-End Verification And Release Readiness

**Goal**: Prove that the documented release flow works before the feature is treated as complete.

**Validation steps**:

1. Run `bun run check`.
2. Run packaging smoke validation and inspect `npm pack --dry-run` output.
3. Confirm package metadata, tarball contents, and CLI-reported version stay aligned.
4. Confirm `ci.yml` uses `actions/cache@v5` consistently.
5. Confirm `release-please.yml` contains the expected OIDC-only permissions and publish steps.
6. Confirm the GitHub Release record for the published version exposes both the version identifier and a discoverable summary of what changed in that release.
7. Confirm `README.md`, `docs/development.md`, `docs/command-reference.md`, and `docs/maintenance.md` all describe the same supported workflow and point users to the canonical release-information surface.
8. After first real publish, verify `bunx --package @chrisleekr/agentsync agentsync --version` resolves the released package and reports the expected version.

**Exit criteria**:

1. The package is publishable and no longer blocked by private metadata.
2. The documented `bunx` command resolves and launches the released CLI.
3. The publish workflow uses GitHub OIDC trusted publishing and no long-lived npm token path remains.
4. Packaging validation catches broken `bin`, tarball, or version-surface regressions before release.
5. The release record exposes the published version and a discoverable summary of changes.
6. Toolchain pins and documentation are consistent across user, contributor, and maintainer workflows.
