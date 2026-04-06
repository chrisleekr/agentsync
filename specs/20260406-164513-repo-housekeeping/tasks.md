# Tasks: Repository Housekeeping

**Input**: Design documents from `/specs/20260406-164513-repo-housekeeping/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md

**Tests**: Automated tests are required. This feature modifies runtime source files (`pull.ts`, `status.ts`, `cursor.ts`, `registry.ts`, `git.ts`) and CI workflows — it does NOT qualify for the documentation-only exception.

**Organization**: Tasks are grouped by user story. All 3 user stories are fully independent — they touch different files and can be implemented in any order or in parallel.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependency changes shared across stories

- [x] T001 Add `picocolors` to explicit dependencies in package.json
- [x] T002 Pin `bun-types` from `"^1.3.9"` to `"1.3.9"` in package.json devDependencies (FR-004)
- [x] T003 Run `bun install` to update bun.lock after dependency changes

**Checkpoint**: Dependencies updated. All user stories can now begin in parallel.

---

## Phase 2: User Story 1 — CI Pipeline Correctness (Priority: P1) MVP

**Goal**: Fix invalid GitHub Action versions, expand release binary matrix, add package smoke test

**Independent Test**: Push a commit to a PR and verify all CI jobs pass. Validate the matrix produces 4 binary entries.

### Tests for User Story 1

> CI workflow changes are validated by CI itself — no unit tests needed. Validation is via `act` or PR run.

### Implementation for User Story 1

- [x] T004 ~~[P] [US1] Replace action versions~~ **DROPPED** — `actions/checkout@v6` and `actions/setup-node@v6` ARE the latest versions as of April 2026. FR-001 was based on stale knowledge. No change needed.
- [x] T005 ~~[P] [US1] Replace action versions~~ **DROPPED** — same as T004
- [x] T006 [US1] Add `linux-arm64` and `macos-x64` matrix entries to build-and-upload job in .github/workflows/release-please.yml with `--target` cross-compilation flags (FR-002)
- [x] T007 [US1] Add `build-package` smoke test job to .github/workflows/ci.yml that runs `bun run build:package && npm pack --dry-run` after test job (FR-003)

**Checkpoint**: CI workflows use valid action versions, release matrix covers 4 platforms, package build is smoke-tested on every PR.

---

## Phase 3: User Story 2 — Type Safety and Code Correctness (Priority: P2)

**Goal**: Remove unsafe `as` casts from registry, wire `--force` through pull command

**Independent Test**: `bun run typecheck` passes with zero `as` casts in registry.ts. `agentsync pull --force` skips conflict prompts on diverged history.

### Tests for User Story 2

- [x] T008 [P] [US2] Add test in src/core/__tests__/git.test.ts: `reconcileWithRemote` with `force: true` resets local to remote when history diverges — expect status `"fast-forwarded"`
- [x] T009 [P] [US2] Add test in src/core/__tests__/git.test.ts: `reconcileWithRemote` with `force: false` (default) still throws `DIVERGED_HISTORY` on diverged history
- [x] T010 [P] [US2] Add test in src/commands/__tests__/pull.test.ts: verify `performPull({ force: true })` passes force option through to `reconcileWithRemote`

### Implementation for User Story 2

- [x] T011 [US2] Add `force?: boolean` to `GitReconciliationOptions` interface in src/core/git.ts
- [x] T012 [US2] Add force-path logic in `reconcileWithRemote()` in src/core/git.ts — before `DIVERGED_HISTORY` throw, if `options.force`, run `git reset --hard` to remote ref and return `"fast-forwarded"`
- [x] T013 [US2] Add `force?: boolean` to `performPull()` options type in src/commands/pull.ts and forward it to `git.reconcileWithRemote()`
- [x] T014 [US2] Pass `args.force` from `pullCommand.run()` to `performPull()` in src/commands/pull.ts
- [x] T015 [P] [US2] Change `snapshotClaude()` return type to `Promise<SnapshotResult>` and import `SnapshotResult` from `./_utils` in src/agents/claude.ts (FR-008)
- [x] T016 [P] [US2] Change `snapshotCursor()` return type to `Promise<SnapshotResult>` and import `SnapshotResult` from `./_utils` in src/agents/cursor.ts (FR-008)
- [x] T017 [P] [US2] Change `snapshotCodex()` return type to `Promise<SnapshotResult>` and import `SnapshotResult` from `./_utils` in src/agents/codex.ts (FR-008)
- [x] T018 [P] [US2] Change `snapshotCopilot()` return type to `Promise<SnapshotResult>` and import `SnapshotResult` from `./_utils` in src/agents/copilot.ts (FR-008)
- [x] T019 [P] [US2] Change `snapshotVsCode()` return type to `Promise<SnapshotResult>` and import `SnapshotResult` from `./_utils` in src/agents/vscode.ts (FR-008)
- [x] T020 [US2] Remove all 5 `as () => Promise<SnapshotResult>` casts from src/agents/registry.ts (FR-008)
- [x] T021 [US2] Update agent-specific type aliases to `type ClaudeSnapshotResult = SnapshotResult` (etc.) in each adapter to preserve re-export compatibility in src/agents/registry.ts
- [x] T022 [US2] Run `bun run typecheck` to verify zero type errors after cast removal

**Checkpoint**: All `as` casts removed, `--force` flag functional, `bun run typecheck` passes.

---

## Phase 4: User Story 3 — Observability and Developer Experience (Priority: P3)

**Goal**: Add terminal colours to status output, warn on unrecognised vault files during Cursor apply

**Independent Test**: `agentsync status` shows coloured output. Placing unknown `.age` file in Cursor vault produces warning.

### Tests for User Story 3

- [x] T023 [P] [US3] Add test in src/commands/__tests__/status.test.ts: verify `statusDisplay` mapping returns ANSI-escaped strings for each SyncStatus value
- [x] T024 [P] [US3] Add test in src/agents/__tests__/cursor.test.ts: `applyCursorVault` logs warning when encountering unknown `.age` file in cursor vault directory

### Implementation for User Story 3

- [x] T025 [US3] Import `pc` from `picocolors` in src/commands/status.ts and update `statusDisplay` mapping to use `pc.green("synced")`, `pc.yellow("local-changed")`, `pc.cyan("vault-only")`, `pc.dim("local-only")`, `pc.red("error")` (FR-006)
- [x] T026 [US3] Add `else { log.warn(...) }` branch after the `user-rules.md.age` / `mcp.json.age` conditionals in `applyCursorVault()` in src/agents/cursor.ts (FR-007)

**Checkpoint**: Status output is visually scannable, unknown vault files produce warnings.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and commit hygiene

- [x] T027 Run `bun run check` (typecheck + lint + test) to verify all changes pass
- [x] T028 Update JSDoc for `reconcileWithRemote()` in src/core/git.ts to document the new `force` option behaviour
- [x] T029 Update JSDoc for `performPull()` in src/commands/pull.ts to document the new `force` option
- [x] T030 Run quickstart.md validation steps (10-step manual checklist)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **User Stories (Phase 2-4)**: Depend on Setup completion (T001-T003 for dependency changes)
  - US1 (Phase 2) and US2 (Phase 3) and US3 (Phase 4) are **fully independent** — different files, no cross-dependencies
- **Polish (Phase 5)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Only touches `.github/workflows/` YAML files — no source code
- **User Story 2 (P2)**: Only touches `src/core/git.ts`, `src/commands/pull.ts`, `src/agents/*.ts`, `src/agents/registry.ts`
- **User Story 3 (P3)**: Only touches `src/commands/status.ts`, `src/agents/cursor.ts`

**Note**: US2 and US3 both touch `src/agents/cursor.ts` but in different functions (`snapshotCursor` return type vs `applyCursorVault` warning). These are non-conflicting edits.

### Within Each User Story

- Tests written and verified to FAIL before implementation
- Implementation in dependency order (interfaces before consumers)
- Story complete before moving to next priority

### Parallel Opportunities

- T004-T005 (action version fixes) can run in parallel — different files
- T008-T010 (US2 tests) can all run in parallel
- T015-T019 (adapter return type changes) can all run in parallel — different files
- T023-T024 (US3 tests) can run in parallel
- All 3 user stories can run in parallel after Setup

---

## Parallel Example: User Story 2

```bash
# Launch all tests for US2 together:
Task: "T008 - Test reconcileWithRemote force:true in src/core/__tests__/git.test.ts"
Task: "T009 - Test reconcileWithRemote force:false in src/core/__tests__/git.test.ts"
Task: "T010 - Test performPull force forwarding in src/commands/__tests__/pull.test.ts"

# Launch all adapter type changes together:
Task: "T015 - Change snapshotClaude return type in src/agents/claude.ts"
Task: "T016 - Change snapshotCursor return type in src/agents/cursor.ts"
Task: "T017 - Change snapshotCodex return type in src/agents/codex.ts"
Task: "T018 - Change snapshotCopilot return type in src/agents/copilot.ts"
Task: "T019 - Change snapshotVsCode return type in src/agents/vscode.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T003)
2. Complete Phase 2: User Story 1 — CI fixes (T004-T007)
3. **STOP and VALIDATE**: Push PR, verify CI passes with valid actions and 4-target matrix
4. This alone delivers the highest-impact fixes (broken CI versions)

### Incremental Delivery

1. Setup → Dependencies updated
2. US1 → CI pipeline correct → Commit: `fix(ci)` + `feat(ci)` (3 commits)
3. US2 → Type safety restored → Commit: `feat(pull)` + `refactor(agents)` (2 commits)
4. US3 → Observability improved → Commit: `feat(status)` + `fix(cursor)` (2 commits)
5. Polish → JSDoc + final validation → Commit: `docs(pull)` (1 commit)

### Commit Plan (8 commits)

1. `fix(ci): pin actions/checkout and actions/setup-node to v4`
2. `feat(ci): add linux-arm64 and macos-x64 to release binary matrix`
3. `feat(ci): add package build smoke test to PR pipeline`
4. `fix(deps): pin bun-types to exact version matching .bun-version`
5. `feat(pull): wire --force flag through to reconcileWithRemote`
6. `refactor(agents): remove unsafe as casts from snapshot registry`
7. `feat(status): add terminal colour to sync status display`
8. `fix(cursor): warn on unrecognised .age files during vault apply`

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- All 3 user stories are independently completable and testable
- US2 and US3 share `cursor.ts` but edit different functions — non-conflicting
- Commit after each logical group per the commit plan
- Stop at any checkpoint to validate story independently
