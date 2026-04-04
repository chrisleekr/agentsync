# Feature Specification: Fix CI Pipeline

**Feature Branch**: `20260404-231650-fix-ci-pipeline`
**Created**: 2026-04-04
**Status**: Draft
**Input**: User description: "Fix CI pipeline"

## User Scenarios & Testing _(mandatory)_

### User Story 1 - CI Passes Reliably on Every PR (Priority: P1)

A contributor opens a pull request and the CI pipeline runs to completion without false failures. All three jobs — lint & typecheck, unit tests, and binary build — succeed against the current codebase. The contributor receives a green check and can merge with confidence.

**Why this priority**: A broken CI pipeline blocks all forward progress. No PR can be safely merged until the pipeline is green, making this the single highest-value fix.

**Independent Test**: Can be fully tested by opening a PR against `main` and observing all three GitHub Actions jobs complete with green status, delivering a trustworthy gate on code quality.

**Acceptance Scenarios**:

1. **Given** a pull request is opened against `main`, **When** the CI workflow triggers, **Then** all three jobs (lint, test, build) complete with a success status within 5 minutes.
2. **Given** a previously failing job, **When** the root cause is resolved, **Then** that job succeeds on the next push without requiring manual intervention.
3. **Given** a new push to an active PR, **When** a concurrent run is already in progress, **Then** the older run is cancelled and only the latest run completes.

---

### User Story 2 - Lint Failure Blocks Tests and Build (Priority: P2)

A contributor pushes code that has a linting error. The CI pipeline reports the lint failure immediately and does not waste compute time running tests or building the binary on known-bad code.

**Why this priority**: Enforcing job ordering prevents wasted CI minutes and gives faster, clearer feedback -- contributors know the exact first failure point without reading multiple job logs.

**Independent Test**: Can be fully tested by pushing a commit with a deliberate lint error and confirming only the lint job executes, with test and build jobs skipped or blocked.

**Acceptance Scenarios**:

1. **Given** code with a lint error is pushed, **When** CI runs, **Then** only the lint job executes first and fails fast.
2. **Given** lint passes, **When** CI continues, **Then** test and build jobs execute in the appropriate order.
3. **Given** tests fail, **When** CI evaluates remaining jobs, **Then** the build job does not run.

---

### User Story 3 - Dependency Caching Speeds Up CI Runs (Priority: P3)

A contributor pushes multiple commits in quick succession. Each subsequent CI run restores the dependency cache rather than re-downloading all packages from scratch, noticeably reducing total job duration.

**Why this priority**: Caching is a quality-of-life improvement that reduces feedback loop time without changing correctness. Important but not blocking.

**Independent Test**: Can be fully tested by pushing two consecutive commits with identical dependencies and observing that the second run reports a cache hit and completes faster than the first.

**Acceptance Scenarios**:

1. **Given** dependencies have not changed between two pushes, **When** the second CI run executes, **Then** the cache is restored and the install step is near-instant.
2. **Given** a dependency is added or updated, **When** CI runs, **Then** the cache is invalidated and dependencies are re-downloaded and cached fresh.
3. **Given** the release workflow runs after a tag is created, **When** it installs dependencies, **Then** it also benefits from the same caching strategy as the CI workflow.

---

---

### User Story 4 - All Dependabot PRs Closed by This Feature (Priority: P2)

All 3 open Dependabot PRs (#2 `actions/checkout` v4→v6, #3 `biome`+`typescript` major bumps, #4 `zod`+`@clack/prompts`+`citty` major bumps) are adopted and implemented within this feature branch. On merge to `main`, each Dependabot PR is automatically closed by GitHub because the same commits are already present in `main`.

**Why this priority**: Leaving Dependabot PRs open after a CI fix is merged means the pipeline immediately faces three unreviewed breaking-change upgrades. Absorbing them here forces a single integration cycle with one green CI gate rather than three sequential risky merges.

**Independent Test**: After merge to `main`, all three Dependabot PRs must show GitHub status "Closed" (auto-closed, not rejected). The final commit on `main` must include all upgraded package versions.

**Acceptance Scenarios**:

1. **Given** this feature branch is merged to `main`, **When** GitHub reconciles Dependabot PRs #2, #3, and #4, **Then** all three are automatically closed without manual action.
2. **Given** `zod` is upgraded to v4 in `package.json`, **When** all existing schemas are audited, **Then** every schema compiles and validates correctly with no v3 deprecated API usage remaining.
3. **Given** `@biomejs/biome` is upgraded to v2 in `package.json`, **When** `bun run check` is executed, **Then** no lint or format errors are reported on any existing source file.
4. **Given** `typescript` is upgraded to v6 in `package.json`, **When** type checking runs, **Then** zero new type errors are introduced by the version bump.

---

### Edge Cases

- What happens when `bun.lock` is missing or corrupt in the repository? The install step must fail with a clear error rather than silently proceeding with a non-reproducible install.
- How does the pipeline handle a Bun runtime version that produces different output across OS platforms? The build job must produce a runnable binary on the target OS without platform-specific failures.
- What happens if a test file imports a module that does not exist at CI time? The test job must report the import failure as a test error, not a runner crash.
- **Zod v4 breaking changes**: `z.string().nonempty()` and other v3-only methods may be removed or renamed; all schema definitions must be audited and migrated to the Zod v4 API before merge.
- **Biome v2 config schema**: The `biome.json` configuration schema changed between v1 and v2; the config file must be migrated using `biome migrate` or manual review so that `bun run check` passes without warnings.
- **TypeScript 6 strictness**: TypeScript 6 may tighten inference rules or remove deprecated type utilities; any resulting type errors must be resolved — suppression with `@ts-ignore` is not acceptable.
- **`actions/checkout` v6 token behaviour**: v6 changes the default `persist-credentials` behaviour; any workflow step that relies on embedded tokens post-checkout must be verified to still function correctly.
- **`@clack/prompts` v1.x API changes**: Breaking API changes from v0.9 to v1.2 must be audited against all CLI interaction code in `src/cli.ts` and prompt-dependent modules.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The CI workflow MUST run on every push to `main` and on every pull request targeting `main`.
- **FR-002**: The lint job MUST run type checking and linting as separate named steps, providing distinct failure signals.
- **FR-003**: The test job MUST execute all unit tests and report pass/fail status per test file.
- **FR-004**: The build job MUST compile the CLI entry point into a self-contained binary and verify the output artifact exists.
- **FR-005**: The test job MUST only run after the lint job succeeds; the build job MUST only run after the test job succeeds.
- **FR-006**: Dependency installation MUST use a locked install to guarantee reproducibility across runs.
- **FR-007**: The dependency cache MUST be keyed on the exact content of the lockfile so that any change to dependencies invalidates the cache.
- **FR-008**: The release workflow MUST apply the same caching strategy as the CI workflow to avoid redundant downloads during release builds.
- **FR-009**: The test job MUST enforce a minimum coverage threshold of 90% lines and 90% functions, configured via `coverageThreshold = { lines = 0.9, functions = 0.9 }` in `bunfig.toml`; `bun test` MUST exit with a non-zero exit code if coverage drops below this threshold.
- **FR-010**: All GitHub Actions workflow files MUST upgrade `actions/checkout` from `v4` to `v6`; `persist-credentials` behaviour must be verified post-upgrade.
- **FR-011**: `@biomejs/biome` MUST be upgraded from `1.x` to `2.x` in `package.json`; `biome.json` MUST be migrated to the v2 config schema such that `bun run check` passes with zero errors or warnings.
- **FR-012**: `typescript` MUST be upgraded from `5.x` to `6.x` in `package.json`; all resulting type errors MUST be resolved without suppression (`@ts-ignore` / `@ts-expect-error` are not acceptable for newly introduced errors).
- **FR-013**: `zod` MUST be upgraded from `3.x` to `4.x` in `package.json`; all schema definitions in `src/` MUST be audited and migrated to the Zod v4 API with no v3-deprecated methods remaining.
- **FR-014**: `@clack/prompts` MUST be upgraded from `0.9.x` to `1.2.x` and `citty` from `0.1.x` to `0.2.x`; all breaking API changes MUST be resolved in `src/` before merge.
- **FR-015**: On merge of this feature branch into `main`, all three Dependabot PRs (#2, #3, #4) MUST be automatically closed by GitHub with no manual dismissal required.

### Non-Functional Requirements

- **NFR-001**: Each CI job MUST complete within 5 minutes under normal conditions.
- **NFR-002**: CI configuration MUST use the minimum permissions required per job (read-only by default; write access only for release artifact upload).

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Every pull request against `main` results in all three CI jobs (lint, test, build) completing with a green status on the first run, for at least 5 consecutive PRs after the fix is applied.
- **SC-002**: Subsequent CI runs on branches with unchanged dependencies complete the install step in under 10 seconds due to cache restoration.
- **SC-003**: A push with a lint error causes only the lint job to execute; test and build jobs are skipped, reducing wasted compute by at least 60% compared to running all jobs regardless of lint outcome.
- **SC-004**: The end-to-end CI pipeline (lint -> test -> build) completes in under 5 minutes for a clean run from cache.
- **SC-005**: After this feature branch merges to `main`, all three Dependabot PRs (#2, #3, #4) show GitHub status "Closed" (auto-closed by commit inclusion), confirmed by `gh pr list --state closed` showing all three.

## Assumptions

- The GitHub Actions runner environment (`ubuntu-latest`) is the primary CI target; macOS and Windows runners are out of scope except for the release artifact matrix.
- The Bun lockfile format in use is the text-based `bun.lock` introduced in Bun v1.2, not the legacy binary `bun.lockb`.
- Bun runtime is pinned to `1.3.9` to resolve the Linux `atomicWrite` rename bug present in `1.2.9`; a `.bun-version` file is added for consistent local/CI parity.
- Code coverage is enforced at 90% lines and 90% functions via `coverageThreshold = { lines = 0.9, functions = 0.9 }` in `bunfig.toml`; the CI test job exits non-zero if coverage drops below this threshold.
- The release workflow (`release-please.yml`) is in scope for caching improvements but not for job ordering changes, as it has a structurally different dependency graph.
- All three open Dependabot PRs (#2 `actions/checkout` v4→v6, #3 `@biomejs/biome` v1→v2 + `typescript` v5→v6 + `@types/node` v22→v25, #4 `zod` v3→v4 + `@clack/prompts` v0.9→v1.2 + `citty` v0.1→v0.2) are implemented within this feature branch; these PRs will be automatically closed by GitHub upon merge to `main`.
- All breaking changes introduced by upgraded packages are resolved as part of this feature's implementation; no deferred follow-up PRs are acceptable.

## Clarifications

### Session 2026-04-05

- Q: Should test coverage failures gate the CI pipeline, and if so at what threshold? → A: Hard gate — add `coverageThreshold = { lines = 0.9, functions = 0.9 }` to `bunfig.toml`; `bun test` exits non-zero if coverage drops below threshold (FR-009 resolved).
- Q: Is the pinned Bun runtime version (1.2.9) intentionally fixed or should it be upgraded as part of this feature? → A: Upgrade to 1.3.9 — the Linux `atomicWrite` rename bug in 1.2.9 is the root cause of the CI failure; upgrading is in scope (Assumptions updated).
- Q: Should the 3 open Dependabot PRs (#2 `actions/checkout` v4→v6, #3 `biome`+`typescript` major bumps, #4 `zod`+`@clack/prompts`+`citty` major bumps) be merged before, after, or within this feature branch? → A: Include all 3 within this feature — implement all dependency upgrades here and auto-close all Dependabot PRs on merge (FR-010–FR-015, User Story 4, SC-005 added; Assumptions updated).
