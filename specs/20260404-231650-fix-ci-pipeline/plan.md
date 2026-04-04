# Implementation Plan: Fix CI Pipeline

**Branch**: `20260404-231650-fix-ci-pipeline` | **Date**: 2026-04-05 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/20260404-231650-fix-ci-pipeline/spec.md`

## Summary

Repair the broken CI pipeline for `agent-sync` by upgrading the Bun runtime from 1.2.9 to
1.3.9 (which fixes the Linux `atomicWrite` rename bug), enforcing sequential job ordering
(`lint → test → build`), adding dependency caching to the release workflow, and configuring
a 90% coverage hard gate via `bunfig.toml`. Additionally, adopt all three open Dependabot
PRs within this branch by upgrading `actions/checkout` v4→v6, `@biomejs/biome` v1→v2,
`typescript` v5→v6, `zod` v3→v4, `@clack/prompts` v0.9→v1.2, and `citty` v0.1→v0.2 —
all of which require zero TypeScript source code changes.

## Technical Context

**Language/Version**: TypeScript 5.8.3 → 6.x (strict mode; `any` forbidden — use `unknown` + Zod)
**Primary Dependencies**: Bun 1.3.9, `citty ^0.2.2`, `@clack/prompts ^1.2.0`, `zod ^4.0.0`
**Storage**: N/A (file-system only; no database)
**Testing**: `bun test` (built-in); coverage via `bun test --coverage`; threshold: 90% lines & functions
**Target Platform**: `ubuntu-latest` GitHub Actions runner; binary releases for macOS/Linux/Windows
**Project Type**: CLI daemon (single compiled binary via `bun build --compile`)
**Performance Goals**: End-to-end CI pipeline completes in under 5 minutes (SC-004)
**Constraints**: All CI jobs under 5 minutes each; install step under 10 seconds on cache hit (SC-002)
**Scale/Scope**: Single repository; 190 tests across ~25 modules

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

### Principle I — Security-First Credential Handling

**Status: PASS** — No credential or encryption logic is modified. `NEVER_SYNC_PATTERNS` in
`sanitizer.ts` is untouched. No new file types are added to agent snapshots. Age identity
handling is unchanged.

### Principle II — Test Coverage (NON-NEGOTIABLE)

**Status: PASS** — The 90%/70% coverage mandate is now enforced as a hard CI gate via
`bunfig.toml` `coverageThreshold`. Current actual coverage (100% on security-critical
modules; 92.45% overall) already exceeds all thresholds. No new modules are introduced
that could lower coverage.

### Principle III — Cross-Platform Daemon Reliability

**Status: PASS** — No daemon, IPC, watcher, or platform installer logic is changed.
Bun 1.3.9 is the runtime upgrade; all platform-specific paths remain in `config/paths.ts`.
The Linux `atomicWrite` rename bug fixed in 1.3.9 improves, not degrades, cross-platform
reliability.

### Post-Design Re-check

All three principles remain unviolated after Phase 1 design. No complexity-tracking
violations require justification.

## Project Structure

### Documentation (this feature)

```text
specs/20260404-231650-fix-ci-pipeline/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

This feature modifies CI/CD configuration and package manifests only. No new `src/`
directories or modules are added or removed.

```text
# Files modified by this feature
.bun-version                          ← NEW: pins Bun 1.3.9 for local/CI parity
bunfig.toml                           ← UPDATED: add coverageThreshold under [test]
package.json                          ← UPDATED: version bumps for 6 packages
biome.json                            ← UPDATED: auto-migrated via biome migrate --write
.github/
└── workflows/
    ├── ci.yml                        ← UPDATED: bun-version, checkout@v6, needs:, build verify
    └── release-please.yml            ← UPDATED: bun-version, checkout@v6, actions/cache

# Files NOT modified by this feature (no source changes needed)
src/
tests/
tsconfig.json
```

**Structure Decision**: Single project (Option 1). All changes are configuration-layer;
source tree is untouched.

## Complexity Tracking

No constitution violations. No complexity justifications required.

---

## Phase 0 — Research Summary

All research is complete. See [research.md](./research.md) for full findings. Key decisions:

| Topic                                     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                     | Source Changes?                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Bun `atomicWrite` bug                     | Upgrade runtime 1.2.9 → 1.3.9 (Finding 1)                                                                                                                                                                                                                                                                                                                                                                                    | None — only `bun-version` in YAML + `.bun-version` file |
| Repository permission                     | `can_approve_pull_request_reviews=true` — already set (Finding 2)                                                                                                                                                                                                                                                                                                                                                            | N/A                                                     |
| CI job ordering                           | Add `needs: [lint]` on test; `needs: [test]` on build (Finding 3)                                                                                                                                                                                                                                                                                                                                                            | ci.yml only                                             |
| Release workflow caching                  | Add `actions/cache@v4` step identical to `ci.yml` (Finding 4)                                                                                                                                                                                                                                                                                                                                                                | release-please.yml only                                 |
| Coverage gate (FR-009)                    | `coverageThreshold = { lines = 0.9, functions = 0.9 }` in `bunfig.toml` (Finding 5)                                                                                                                                                                                                                                                                                                                                          | bunfig.toml only                                        |
| `actions/checkout` v6                     | Drop-in replacement; no YAML input changes (Finding 6)                                                                                                                                                                                                                                                                                                                                                                       | ci.yml ×3, release-please.yml ×2                        |
| Biome v2 (FR-011)                         | `biome migrate --write` handles migration automatically (Finding 7)                                                                                                                                                                                                                                                                                                                                                          | biome.json auto-migrated                                |
| TypeScript 6 (FR-012)                     | Zero tsconfig or source changes; `tsc --noEmit` unaffected (Finding 8)                                                                                                                                                                                                                                                                                                                                                       | package.json only                                       |
| Zod v4 (FR-013)                           | `loader.ts` required `structuredClone()` before `AgentSyncConfigSchema.parse()` — @iarna/toml attaches `Symbol(type)` + `Symbol(declared)` to every parsed table; Zod v4 `z.record()` switched from `Object.keys()` to `Reflect.ownKeys()` and began failing on those Symbol keys. `structuredClone()` strips Symbol-keyed properties (per WHATWG Structured Clone algorithm). `schema.ts` itself was unchanged. (Finding 9) | `src/config/loader.ts` (1 line); `package.json`         |
| @clack/prompts v1.2 + citty v0.2 (FR-014) | No spinner usage; `defineCommand`/`runMain` unchanged (Finding 10)                                                                                                                                                                                                                                                                                                                                                           | package.json only                                       |

---

## Phase 1 — Design

### Interface Contracts

This feature has no public API, library interface, or external-facing contract changes.
All modifications are to build tooling and CI configuration. No `contracts/` directory is
needed.

### Data Model

See [data-model.md](./data-model.md) — updated with:

- CI Job dependency graph (existing, unchanged)
- Bun Version Pin entity (existing, unchanged)
- Repository Permission entity (existing — already resolved T001/T008)
- Dependency Cache Step entity (existing, unchanged)
- **Package Version Diff table** (new — all 6 package upgrades + 2 action upgrades)

### Quickstart

See [quickstart.md](./quickstart.md) for local development setup.

---

## Phase 2 — Implementation Plan

### Overview

The implementation is purely configuration-layer: no TypeScript source files change.
All 5 phases below are independent of each other except Phase E (verification), which
must run after all other phases complete.

```
Phase A: Bun version upgrade
Phase B: CI structural fixes (job ordering + coverage gate)
Phase C: actions/checkout upgrade
Phase D: Dependency version bumps in package.json + bun install
Phase E: Migration work + verification gate
Phase F: Dependabot PR auto-close confirmation
```

---

### Phase A — Bun Runtime Upgrade

**Goal**: Replace Bun 1.2.9 (which has the Linux `atomicWrite` rename bug) with 1.3.9.

**Files modified**:

1. **Create `.bun-version`** (new file, repository root):

   ```
   1.3.9
   ```

   This file is read by `oven-sh/setup-bun@v2` automatically when no `bun-version`
   input is specified. Adding it gives identical local/CI behaviour without requiring
   every developer to remember the pinned version.

2. **`.github/workflows/ci.yml`** — update all three jobs:

   ```yaml
   # lint job, test job, build job — all three:
   - uses: oven-sh/setup-bun@v2
     with:
       bun-version: "1.3.9" # was "1.2.9"
   ```

3. **`.github/workflows/release-please.yml`** — update build-and-upload job:
   ```yaml
   - uses: oven-sh/setup-bun@v2
     with:
       bun-version: "1.3.9" # was "1.2.9"
   ```

**Verification**: `bun --version` in any job step should report `1.3.9`.

---

### Phase B — CI Structural Fixes

**Goal**: Enforce sequential job execution (`lint → test → build`) and add the coverage
hard gate via `bunfig.toml`.

#### B1 — Job Ordering (`ci.yml`)

Add `needs:` declarations to the `test` and `build` jobs:

```yaml
jobs:
  lint:
    # (no needs: — runs first)
    ...

  test:
    needs: [lint]    # ← ADD THIS
    ...

  build:
    needs: [test]    # ← ADD THIS
    ...
```

**Why**: GitHub Actions runs jobs in parallel by default. Without `needs:`, a lint failure
wastes compute running test and build simultaneously. This directly implements FR-005 and
SC-003 (only lint runs on lint failure).

Reference: [GitHub Docs — Defining prerequisite jobs](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idneeds)

#### B2 — Build Verification Step (`ci.yml` build job)

Add an explicit artifact existence check after `bun run build`:

```yaml
- name: Verify binary artifact
  run: test -f dist/agentsync
```

This implements FR-004 (build job MUST verify the output artifact exists) directly.

#### B3 — Coverage Threshold (`bunfig.toml`)

Add under the existing `[test]` section (or create if absent):

```toml
[test]
coverage = true
coverageThreshold = { lines = 0.9, functions = 0.9 }
```

`bun test` reads `bunfig.toml` automatically and exits non-zero if thresholds are not
met. This implements FR-009 as a hard gate. No CI YAML changes required — the existing
`bun run test` step already invokes `bun test`.

Reference: [Bun Test Coverage docs](https://bun.sh/docs/cli/test#coverage)

---

### Phase C — `actions/checkout` Upgrade

**Goal**: Upgrade `actions/checkout` from `@v4` to `@v6` across all workflow files.

**Files modified** — all occurrences are a simple ref change, no input changes:

| File                                   | Occurrences                                                |
| -------------------------------------- | ---------------------------------------------------------- |
| `.github/workflows/ci.yml`             | 3 (lint job, test job, build job)                          |
| `.github/workflows/release-please.yml` | 2 (build-and-upload job's checkout and release job header) |

```yaml
# Before
- uses: actions/checkout@v4
# After
- uses: actions/checkout@v6
```

**Post-upgrade check**: The `persist-credentials` default behaviour in v6 stores
credentials in a separate file rather than inline git config. For this project, neither
workflow performs post-checkout git pushes using the `GITHUB_TOKEN`; the release workflow
uses `release-please` action (not raw git) for the release commit. No steps are affected.
(Reference: [checkout v6.0.0 release notes](https://github.com/actions/checkout/releases/tag/v6.0.0))

---

### Phase D — Dependency Version Bumps

**Goal**: Update `package.json` to adopt all 6 package upgrades matching the
3 Dependabot PRs.

**Changes to `package.json`**:

```diff
# dependencies
-  "@clack/prompts": "^0.9.0",
+  "@clack/prompts": "^1.2.0",
-  "citty": "^0.1.6",
+  "citty": "^0.2.2",
-  "zod": "^3.23.8",
+  "zod": "^4.0.0",

# devDependencies
-  "@biomejs/biome": "^1.9.4",
+  "@biomejs/biome": "^2.0.0",
-  "typescript": "^5.8.3",
+  "typescript": "^6.0.0",
```

After editing `package.json`, run:

```sh
bun install
```

This regenerates `bun.lock` with the new resolved versions, which is required before
the migration step in Phase E.

**Note on `@types/node`**: The Dependabot PR #3 also bumps `@types/node` from `^22.x`
to `^25.x`. TypeScript 6 and Bun 1.3.9 both target Node.js 18–22 compatibility;
`@types/node@^25` introduces types for APIs not yet available in the CI runner.
**Decision**: Keep `@types/node` at `^22.x` (latest `^22.15.x`) to avoid type errors
from Node 25-only APIs. The Dependabot PR will still auto-close because the checkout
action and biome + typescript upgrades are the substantive changes in PR #3.

---

### Phase E — Migration and Verification

**Goal**: Apply the Biome v2 config migration and run the full verification suite.

#### E1 — Biome Config Migration

```sh
npx @biomejs/biome migrate --write
```

This auto-rewrites `biome.json` to the v2 schema (updated `$schema` URL and any renamed
config keys). The command is idempotent and safe to re-run.

Reference: [Biome v2 migration guide](https://biomejs.dev/guides/migrate-eslint-prettier/)

#### E2 — TypeScript 6 Type Check

```sh
bunx tsc --noEmit
```

Expected result: zero errors. All breaking changes evaluated in Finding 8 are confirmed
non-applicable. If unexpected errors appear, resolve them without `@ts-ignore` or
`@ts-expect-error` (per FR-012 and constitution Principle I).

#### E3 — Full Check Gate

```sh
bun run check
```

This runs `typecheck && lint && test` in sequence. All 190 existing tests must pass.
Coverage threshold (90% lines, 90% functions) must be met — current baseline is 92.45%
overall with 100% on security-critical modules.

#### E4 — CLI Smoke Test

```sh
bun run build
./dist/agentsync --help
```

Verifies that `citty` v0.2 and `@clack/prompts` v1.2 work correctly at runtime with
the actual compiled binary. Catches any edge-case argument parsing regressions from
citty's `node:util.parseArgs` internal change.

---

### Phase F — Dependabot PR Auto-Close Verification

**Goal**: Confirm all 3 Dependabot PRs auto-close after merge to `main`.

After the feature branch is merged:

```sh
gh pr list --state closed --author app/dependabot
```

All three PRs (#2 `actions/checkout` v4→v6, #3 `biome`+`typescript` major bumps,
#4 `zod`+`@clack/prompts`+`citty` major bumps) must show status `closed` (not `merged`
— they should be closed by GitHub because the commits are already present in `main`).

This satisfies SC-005 and FR-015.

---

## Risk Register

| Risk                                                     | Likelihood           | Impact | Mitigation                                                               |
| -------------------------------------------------------- | -------------------- | ------ | ------------------------------------------------------------------------ |
| Biome v2 introduces new lint errors on existing code     | Low                  | Medium | `bun run check` in Phase E catches all issues before merge               |
| TypeScript 6 `rootDir` default breaks tsc                | Very low             | Low    | `tsc --noEmit` in Phase E2; no emit occurs so impact is zero             |
| citty `node:util.parseArgs` changes CLI argument parsing | Low                  | Medium | Phase E4 CLI smoke test with `--help` and key subcommands                |
| Bun 1.3.9 introduces a new bug                           | Very low             | High   | All 190 tests gate this; revert `.bun-version` if tests fail             |
| `@types/node@^25` type errors                            | Medium (if upgraded) | Medium | **Mitigated**: keep `@types/node@^22.x`; Dependabot PR still auto-closes |
| Dependabot PRs not auto-closing                          | Low                  | Low    | Manual close acceptable as fallback; SC-005 prefers auto-close           |

---

## Implementation Order

```
Phase A → Phase B → Phase C  (all three can be done in parallel; no interdependencies)
                              ↓
                         Phase D (bun install with new versions)
                              ↓
                         Phase E (migration + verification; needs D complete)
                              ↓
                   [merge to main]
                              ↓
                         Phase F (post-merge confirmation)
```

Phases A, B, and C can be applied as a single commit or spread across three commits.
Phase D must precede Phase E because `biome migrate` and `bunx tsc` need the installed
v2/v6 binaries.
