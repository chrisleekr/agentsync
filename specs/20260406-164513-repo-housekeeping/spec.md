# Feature Specification: Repository Housekeeping

**Feature Branch**: `20260406-164513-repo-housekeeping`
**Created**: 2026-04-06
**Status**: Draft
**Input**: User description: "Do housekeeping repository — comprehensive audit of CI, type safety, dead code, and developer experience improvements"

## Clarifications

### Session 2026-04-06

- Q: Should the `pull --force` argument be wired through, removed, or deprecated? → A: Wire it through to `performPull()` and `reconcileWithRemote()` to skip conflict prompts.
- Q: Should Windows x64 be included in the release binary matrix now? → A: No — add only linux-arm64 and macos-x64 now; defer Windows until a Windows CI job exists to validate the binary.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - CI Pipeline Correctness (Priority: P1)

As a maintainer, I want all CI workflows to use valid, existing GitHub Action versions and produce binaries for all supported platforms, so that releases are reliable and reach all users.

**Why this priority**: Invalid action versions (`@v6` for checkout and setup-node) risk silent CI failures or hard breaks. Missing binary targets mean users on Intel Mac and Linux ARM cannot use pre-built binaries despite the project supporting those platforms in code.

**Independent Test**: Can be fully tested by pushing a commit to a PR and verifying all CI jobs pass. Release binary matrix can be validated by running `act` locally or by triggering a test release.

**Acceptance Scenarios**:

1. **Given** the CI workflow runs on a PR, **When** the checkout and setup-node actions execute, **Then** they resolve to valid, pinned action versions without warnings or fallback behaviour
2. **Given** a release is created, **When** the build-and-upload job runs, **Then** binaries are produced for linux-x64, linux-arm64, macos-arm64, and macos-x64 (Windows deferred until Windows CI exists)
3. **Given** a PR is opened, **When** CI runs, **Then** a package build smoke test validates that `build:package` and `npm pack --dry-run` succeed

---

### User Story 2 - Type Safety and Code Correctness (Priority: P2)

As a developer, I want the codebase to use proper type narrowing instead of unsafe casts, and declared CLI arguments to be wired through to their implementations, so that refactors don't silently break behaviour.

**Why this priority**: The five `as () => Promise<SnapshotResult>` casts in the agent registry bypass TypeScript's structural checking. The dead `force` argument in `pull.ts` misleads users into thinking `--force` does something.

**Independent Test**: Can be fully tested by running `bun run typecheck` — removing the casts should produce zero type errors if the function signatures are corrected. The `force` arg can be tested by verifying `agentsync pull --force` either works or is no longer offered.

**Acceptance Scenarios**:

1. **Given** the agent registry defines snapshot functions, **When** each agent's snapshot function is registered, **Then** no `as` type assertion is needed — the function signature directly conforms to `AgentDefinition.snapshot`
2. **Given** the `pull` command with `--force`, **When** the flag is passed, **Then** `performPull()` forwards it to `reconcileWithRemote()` to skip conflict prompts, and the CLI help text accurately describes this behaviour
3. **Given** the `bun-types` dev dependency, **When** it is pinned to exact version `1.3.9`, **Then** it matches `.bun-version` and avoids type drift from caret resolution

---

### User Story 3 - Observability and Developer Experience (Priority: P3)

As a developer, I want the `status` command output to be visually scannable and vault operations to surface warnings for unrecognised files, so that I can quickly identify sync problems and configuration drift.

**Why this priority**: Plain text status values without colour distinction make the status table hard to scan, especially with many entries. Silently discarded `.age` files in the Cursor vault applier can mask configuration issues that are difficult to diagnose.

**Independent Test**: Can be tested independently by running `agentsync status` and visually confirming coloured output, and by placing an unknown `.age` file in a Cursor vault directory and verifying a warning is logged during apply.

**Acceptance Scenarios**:

1. **Given** the status command displays sync status for each file, **When** the output is rendered in a terminal, **Then** each status value uses a distinct colour (green for synced, yellow for local-changed, cyan for vault-only, dim/grey for local-only, red for error)
2. **Given** the Cursor vault contains an `.age` file that doesn't match any known handler, **When** `applyCursorVault` processes the directory, **Then** a warning is logged identifying the unrecognised file

---

### Edge Cases

- What happens if Bun cross-compilation fails for a specific target (e.g., linux-arm64 from ubuntu-latest)? The matrix job should fail independently without blocking other targets.
- What happens if `picocolors` (bundled with `@clack/prompts`) changes its API? The colour formatting should use only stable, widely-used functions (`pc.green()`, `pc.yellow()`, `pc.red()`).
- What happens when a new agent is added to the registry? The developer should be guided by TypeScript to provide a conforming snapshot function without needing a cast.

## Requirements *(mandatory)*

### Functional Requirements

- ~~**FR-001**: CI workflows MUST reference valid, existing GitHub Action versions~~ **DROPPED** — verified that `actions/checkout@v6` and `actions/setup-node@v6` are the current latest versions as of April 2026. No change needed.
- **FR-002**: The release binary matrix MUST include targets for linux-x64, linux-arm64, macos-arm64, and macos-x64 (Windows deferred until Windows CI job exists)
- **FR-003**: CI MUST include a package build smoke test that runs `build:package` and `npm pack --dry-run` on every PR
- **FR-004**: The `bun-types` dev dependency MUST be pinned to exact version matching `.bun-version`
- **FR-005**: The `pull` command's `force` argument MUST be wired through to `performPull()` and forwarded to `reconcileWithRemote()` to skip conflict prompts
- **FR-006**: The `status` command MUST display sync status values with distinct terminal colours for each status category
- **FR-007**: The `applyCursorVault` function MUST log a warning when encountering `.age` files that don't match any known handler
- **FR-008**: The agent registry MUST not use `as` type assertions to cast snapshot functions — each function's signature MUST directly conform to the `AgentDefinition.snapshot` type

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All CI workflow jobs pass without warnings about missing or invalid action versions
- **SC-002**: Release artifacts include 4 platform binaries (up from 2) covering linux-x64, linux-arm64, macos-arm64, and macos-x64
- **SC-003**: A deliberately broken `build:package` script causes CI to fail on PRs before reaching the release pipeline
- **SC-004**: `bun run typecheck` passes with zero `as` casts in `registry.ts`
- **SC-005**: Running `agentsync status` in a terminal with colour support shows visually distinct status indicators
- **SC-006**: Placing an unrecognised `.age` file in a Cursor vault directory produces a visible warning during apply

## Assumptions

- The latest stable versions of `actions/checkout` and `actions/setup-node` as of April 2026 are v4 — this will be verified against the official GitHub Actions marketplace before implementation
- Bun's `--target` cross-compilation supports linux-x64, linux-arm64, macos-arm64, and macos-x64 from ubuntu/macos runners; Windows is deferred pending CI infrastructure
- `picocolors` is available as a transitive dependency of `@clack/prompts` and provides stable colour utility functions
- The `force` argument in `pull.ts` was intended to be functional but was left unwired during initial implementation — it will be wired through to `reconcileWithRemote()`
