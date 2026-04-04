# Tasks: Fix CI Pipeline

**Input**: Design documents from `/specs/20260404-231650-fix-ci-pipeline/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅, quickstart.md ✅

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[US1/US2/US3/US4]**: User story label (US1 = CI passes reliably, US2 = job ordering, US3 = caching, US4 = Dependabot PRs closed)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: One-time repository-level change and Bun version pin that unblock all subsequent tasks.

> **Note**: T001 is an out-of-band GitHub API call, not a file edit. It must be done before
> the feature branch is merged so that release-please can create its PR on merge.

- [x] T001 Enable PR creation: run `gh api --method PUT repos/chrisleekr/agentsync/actions/permissions/workflow --field can_approve_pull_request_reviews=true` (out-of-band repo setting, not committed)
- [x] T002 Create `.bun-version` file at repo root with content `1.3.9`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The Bun version upgrade is the root fix for `run/23978676855` (all 190 tests fail
on Bun 1.2.9 Linux). It must land before any user story validation is possible.

**⚠️ CRITICAL**: No user story can be verified until T003–T006 are complete.

- [x] T003 [P] [US1] Bump `bun-version` from `"1.2.9"` to `"1.3.9"` in the `lint` job in `.github/workflows/ci.yml`
- [x] T004 [P] [US1] Bump `bun-version` from `"1.2.9"` to `"1.3.9"` in the `test` job in `.github/workflows/ci.yml`
- [x] T005 [P] [US1] Bump `bun-version` from `"1.2.9"` to `"1.3.9"` in the `build` job in `.github/workflows/ci.yml`
- [x] T006 [P] [US1] Bump `bun-version` from `"1.2.9"` to `"1.3.9"` in the `build-and-upload` job in `.github/workflows/release-please.yml`

**Checkpoint**: After T003–T006, all Bun pins read `"1.3.9"`. The `atomicWrite` ENOENT bug is
eliminated. Run `bun test` locally to confirm 190 still pass.

---

## Phase 3: User Story 1 — CI Passes Reliably on Every PR (Priority: P1) 🎯 MVP

**Goal**: Pull requests against `main` produce an all-green CI run with enforced coverage
threshold and artifact verification. The root cause of `run/23978676855` (Bun 1.2.9 Linux bug)
is fully resolved by the Foundational phase above. FR-001 through FR-009 are satisfied here.

**Independent Test**: Open a PR against `main` → observe lint, test, and build jobs all green
on GitHub Actions. `bun test --coverage` output shows ≥ 90% lines and functions. `dist/agentsync`
binary exists after the build job. No manual intervention required.

### Implementation for User Story 1

- [x] T007 [P] [US1] Add `coverageThreshold = { lines = 0.9, functions = 0.9 }` under the `[test]` section in `bunfig.toml` (FR-009)
- [x] T008 [US1] Verify repo setting: run `gh api repos/chrisleekr/agentsync/actions/permissions/workflow` and confirm `"can_approve_pull_request_reviews": true` (out-of-band, already done)
- [x] T009 [US1] Add `- name: Verify binary artifact` / `run: test -f dist/agentsync` step immediately after the `bun run build` step in the `build` job in `.github/workflows/ci.yml` (FR-004)
- [x] T010 [US1] Run `bun test --coverage` locally and confirm 190 tests pass with 0 failures and coverage ≥ 90% lines and functions — **VERIFIED**: 190 pass / 0 fail; 96.62% functions, 92.58% lines (gate: 90%)

**Checkpoint**: US1 complete — CI pipeline passes on the feature branch with coverage hard gate
and artifact verification; `main` merge will produce green checks and unblock release-please PR.

---

## Phase 4: User Story 2 — Lint Failure Blocks Tests and Build (Priority: P2)

**Goal**: CI enforces lint → test → build sequential ordering. Wasted compute on known-bad
code is eliminated (FR-005, SC-003).

**Independent Test**: Push a commit with a deliberate Biome lint error to the feature branch.
Confirm that only the `lint` job runs and `test`/`build` jobs show "skipped" status on GitHub
Actions.

### Implementation for User Story 2

- [x] T011 [US2] Add `needs: [lint]` to the `test` job in `.github/workflows/ci.yml` (FR-005)
- [x] T012 [US2] Add `needs: [test]` to the `build` job in `.github/workflows/ci.yml` (FR-005)

**Checkpoint**: US2 complete — jobs now execute in dependency order. Verify by reading the
updated `ci.yml` and confirming the `needs:` keys are present on both `test` and `build` jobs.

---

## Phase 5: User Story 3 — Dependency Caching Speeds Up CI Runs (Priority: P3)

**Goal**: The release workflow's `build-and-upload` job restores the Bun dependency cache on
repeated runs, matching what `ci.yml` already does (FR-008, SC-002, SC-004).

**Independent Test**: Push two consecutive commits with identical dependencies. The second
run of the `build-and-upload` job reports "Cache restored" and its install step completes in
< 10 seconds.

### Implementation for User Story 3

- [x] T013 [US3] Add `actions/cache@v4` step to the `build-and-upload` job in `.github/workflows/release-please.yml`, placed after `oven-sh/setup-bun@v2` and before `bun install --frozen-lockfile`, with `path: ~/.bun/install/cache`, `key: ${{ runner.os }}-bun-${{ hashFiles('bun.lock') }}`, and `restore-keys: ${{ runner.os }}-bun-` (FR-008)

**Checkpoint**: US3 complete — `release-please.yml` now has the same caching strategy as
`ci.yml`. Confirm by reading the updated file and checking the cache step is present in the
`build-and-upload` job.

---

## Phase 6: User Story 4 — All Dependabot PRs Closed by This Feature (Priority: P2)

**Goal**: Adopt all 3 open Dependabot PRs within this branch by upgrading `actions/checkout`
v4→v6 (FR-010), `@biomejs/biome` v1→v2 (FR-011), `typescript` v5→v6 (FR-012), `zod` v3→v4
(FR-013), `@clack/prompts` v0.9→v1.2, and `citty` v0.1→v0.2 (FR-014). On merge to `main`,
all three PRs (#2, #3, #4) are automatically closed by GitHub (FR-015, SC-005).

**Independent Test**: After merge to `main`, run `gh pr list --state closed --author app/dependabot`
and confirm PRs #2, #3, #4 all show status `closed`. `bun run check` passes with zero errors
and all 190 tests pass with coverage ≥ 90%.

### Sub-phase: actions/checkout upgrade (FR-010)

- [x] T014 [P] [US4] Change `actions/checkout@v4` → `actions/checkout@v6` in the `lint` job in `.github/workflows/ci.yml`
- [x] T015 [P] [US4] Change `actions/checkout@v4` → `actions/checkout@v6` in the `test` job in `.github/workflows/ci.yml`
- [x] T016 [P] [US4] Change `actions/checkout@v4` → `actions/checkout@v6` in the `build` job in `.github/workflows/ci.yml`
- [x] T017 [P] [US4] Change `actions/checkout@v4` → `actions/checkout@v6` in the `build-and-upload` job in `.github/workflows/release-please.yml`
- [x] T018 [P] [US4] Change `actions/checkout@v4` → `actions/checkout@v6` in the `release-please` job (or second checkout occurrence) in `.github/workflows/release-please.yml` — **VERIFIED NO-OP**: `release-please` job has no `actions/checkout` step; only T017's `build-and-upload` checkout exists

### Sub-phase: Package version bumps (FR-011–FR-014)

- [x] T019 [P] [US4] Update `package.json` `dependencies`: `"zod"` → `"^4.0.0"`, `"@clack/prompts"` → `"^1.2.0"`, `"citty"` → `"^0.2.2"` (FR-013, FR-014)
- [x] T020 [P] [US4] Update `package.json` `devDependencies`: `"@biomejs/biome"` → `"^2.0.0"`, `"typescript"` → `"^6.0.0"` (FR-011, FR-012); keep `@types/node` at `^22.x` (not `^25`)
- [ ] T021 [US4] Run `bun install` to regenerate `bun.lock` with updated package resolutions (depends on T019, T020)

### Sub-phase: Migration and verification (FR-011, FR-012)

- [x] T022 [US4] Run `npx @biomejs/biome migrate --write` to auto-migrate `biome.json` to the v2 schema (depends on T021) (FR-011) — **COMPLETED MANUALLY**: `migrate --write` aborted due to v1 schema parse error; biome.json migrated by hand (`files.ignore→includes`, `organizeImports→assist.actions.source.organizeImports`, `noConsoleLog→noConsole`); `biome check --write` applied `useBiomeIgnoreFolder` safe-fix; `overrides` block added to enforce daemon-only `noConsole` warning per constitution
- [ ] T023 [US4] Run `bunx tsc --noEmit` and confirm zero type errors with TypeScript 6; resolve any errors without `@ts-ignore` or `@ts-expect-error` (depends on T021) (FR-012)
- [ ] T024 [US4] Run `bun run check` (`typecheck && lint && test`) and confirm all 190 tests pass with coverage ≥ 90% lines and functions (depends on T022, T023)
- [ ] T025 [US4] Run `bun run build && ./dist/agentsync --help` as CLI smoke test to verify `citty` v0.2 and `@clack/prompts` v1.2 work correctly in the compiled binary (depends on T024) (FR-014)

### Sub-phase: Dependabot PR auto-close confirmation (FR-015)

- [ ] T026 [US4] After merge to `main`: run `gh pr list --state closed --author app/dependabot` and confirm PRs #2, #3, #4 each show status `closed` (auto-closed by commit inclusion, not manually rejected) (FR-015, SC-005)

**Checkpoint**: US4 complete — all 6 package upgrades adopted; `bun run check` green; Dependabot
PRs auto-closed on merge. Zero `@ts-ignore` suppressions introduced.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final validation sweep confirming all file changes are consistent.

- [x] T027 [P] Read `.github/workflows/ci.yml` and verify: all three `bun-version` pins read `"1.3.9"`, all three steps use `actions/checkout@v6`, `test` job has `needs: [lint]`, `build` job has `needs: [test]`, `test -f dist/agentsync` verify step is present in the `build` job
- [x] T028 [P] Read `.github/workflows/release-please.yml` and verify: `bun-version` reads `"1.3.9"`, both checkout steps use `actions/checkout@v6`, `actions/cache@v4` step is present in `build-and-upload`
- [x] T029 [P] Read `.bun-version` and confirm content is exactly `1.3.9` (no trailing whitespace or newline issues)
- [x] T030 [P] Read `bunfig.toml` and confirm `coverageThreshold = { lines = 0.9, functions = 0.9 }` is present under the `[test]` section
- [x] T031 [P] Read `package.json` and confirm resolved versions: `zod@^4.0.0`, `@clack/prompts@^1.2.0`, `citty@^0.2.2`, `@biomejs/biome@^2.0.0`, `typescript@^6.0.0`, `@types/node` still at `^22.x`

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Setup)
  └─ T002 (.bun-version)
       └─ Phase 2 (Foundational: T003–T006, all parallel)
            ├─ Phase 3 (US1: T007, T009, T010 — T007 [P] with T009)
            ├─ Phase 4 (US2: T011, T012)          ← runs in parallel with US1 & US3
            ├─ Phase 5 (US3: T013)                ← runs in parallel with US1 & US2
            └─ Phase 6 (US4: T014–T026)
                 ├─ T014–T018 [P] checkout bumps (parallel, different files)
                 ├─ T019–T020 [P] package.json edits (parallel — different keys)
                 └─ T021 bun install
                      ├─ T022 biome migrate
                      ├─ T023 tsc --noEmit
                      └─ T024 bun run check
                           └─ T025 CLI smoke test
                                └─ T026 (post-merge) gh pr list verify
Phase 7 (Polish: T027–T031, all parallel) — after all story phases complete
```

### User Story Dependencies

- **US1 (P1)**: Unblocked by T003–T006. Independent from US2, US3, US4.
- **US2 (P2)**: Unblocked by T003–T006. Edits `ci.yml` — no conflict with US3 (`release-please.yml`) or US4 (different lines/keys).
- **US3 (P3)**: Unblocked by T003–T006. Edits only `release-please.yml` — fully independent from US2.
- **US4 (P2)**: Unblocked by T003–T006. Has internal sequential dependency: T021 blocks T022–T023, which block T024, which blocks T025. T026 is post-merge.

### Parallel Opportunities

| Parallel group         | Tasks                        | Condition                                                      |
| ---------------------- | ---------------------------- | -------------------------------------------------------------- |
| Bun version bump       | T003, T004, T005, T006       | All after T002; edit different jobs / different files          |
| US1 + US2 + US3        | T007, T009–T013              | All after Foundational; T007 can start with T009               |
| checkout@v6 bumps      | T014, T015, T016, T017, T018 | All after Foundational; edit different jobs in different files |
| package.json key edits | T019, T020                   | Edit non-overlapping dependency sections                       |
| Post-install parallel  | T022, T023                   | Both depend on T021 only; independent of each other            |
| Polish checks          | T027, T028, T029, T030, T031 | All after all story phases complete                            |

---

## Parallel Example: Phase 6 US4 Sub-phases

```bash
# T014–T018: all checkout bumps can run concurrently (different files / jobs):
#   T014 — ci.yml lint job:            actions/checkout@v4 → @v6
#   T015 — ci.yml test job:            actions/checkout@v4 → @v6
#   T016 — ci.yml build job:           actions/checkout@v4 → @v6
#   T017 — release-please.yml job 1:   actions/checkout@v4 → @v6
#   T018 — release-please.yml job 2:   actions/checkout@v4 → @v6

# T019–T020: package.json edits can run concurrently (different sections):
#   T019 — dependencies block:  zod, @clack/prompts, citty
#   T020 — devDependencies:     @biomejs/biome, typescript

# T022–T023: after T021 (bun install), run concurrently:
#   T022 — biome migrate --write
#   T023 — tsc --noEmit
```

---

## Implementation Strategy

**MVP scope**: Phase 1 + Phase 2 + Phase 3 (US1) — T001–T010.
This resolves both failing CI runs (Bun 1.2.9 atomicWrite bug) with coverage gate and
artifact verification. Safe to merge immediately.

**Recommended approach**: Complete all phases in a single PR for full spec compliance.
Including US4 (Dependabot PRs) prevents three sequential high-risk merges immediately after
the CI fix lands. Total file-edit surface is small (< 30 lines across 2 YAML files + 3 config
files); no TypeScript source changes required.

**Post-merge only**: T026 (`gh pr list` Dependabot confirmation) is the sole post-merge task.
All other tasks execute on the feature branch before opening the PR.
