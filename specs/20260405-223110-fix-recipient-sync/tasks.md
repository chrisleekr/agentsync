# Tasks: Existing Vault Bootstrap Recovery

**Input**: Design documents from `/specs/20260405-223110-fix-recipient-sync/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅, quickstart.md ✅

**Tests**: Automated tests are required for this runtime behavior feature. Include both success-path and error-path coverage for bootstrap, fast-forward updates, and divergence failures.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[US1/US2/US3]**: User story label for traceability

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare the shared multi-machine test fixtures and integration harness needed by all stories.

- [x] T001 [P] Extend multi-machine bare-repo and divergent-history fixture support in `src/test-helpers/fixtures.ts`
- [x] T002 [P] Refactor shared runtime-environment setup helpers for multi-machine sync scenarios in `src/commands/__tests__/integration.test.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the shared Git reconciliation policy and shared test coverage that every user story depends on.

**⚠️ CRITICAL**: No user story should be considered complete until T003-T004 are done.

- [x] T003 Implement remote-state inspection, fast-forward-only update helpers, and typed reconciliation errors in `src/core/git.ts`
- [x] T004 Add unit coverage for empty remote, existing remote, fast-forward update, and divergence cases in `src/core/__tests__/git.test.ts`

**Checkpoint**: The repository has one explicit Git reconciliation policy that command-layer code can reuse consistently.

---

## Phase 3: User Story 1 - Users can initialize a second laptop against an existing vault (Priority: P1) 🎯 MVP

**Goal**: Make `init` join an existing remote vault safely instead of creating a local-only history that later blocks sync.

**Independent Test**: Start with a remote vault that already has history, run `init` on a fresh second machine, and confirm the local vault joins remote history without a non-fast-forward rejection or misleading success outcome.

### Tests for User Story 1

- [x] T005 [US1] Add integration coverage for empty-remote init success, existing-remote bootstrap success, and bootstrap failure messaging in `src/commands/__tests__/integration.test.ts`

### Implementation for User Story 1

- [x] T006 [US1] Rework existing-vault bootstrap sequencing to align local repository state before writing machine-specific history in `src/commands/init.ts`
- [x] T007 [US1] Preserve recipient/config merging while applying the new bootstrap path in `src/commands/init.ts`
- [x] T008 [US1] Tighten `init` success and error messaging so partial bootstrap states do not report full initialization in `src/commands/init.ts`
- [x] T009 [P] [US1] Update existing-vault bootstrap and empty-remote distinction in `docs/command-reference.md`
- [x] T010 [P] [US1] Add second-machine bootstrap failure and recovery guidance in `docs/troubleshooting.md`
- [x] T011 [US1] Align entry-point setup guidance for existing-vault bootstrap semantics in `README.md`

**Checkpoint**: User Story 1 is complete when a second machine can initialize against an existing remote vault on the first attempt without creating divergent local-first history.

---

## Phase 4: User Story 2 - Users can recover from divergent local and remote vault history (Priority: P2)

**Goal**: Make sync flows use the shared reconciliation rule and fail clearly when local and remote history diverge.

**Independent Test**: Reproduce local/remote divergence, run `pull`, and confirm the command exits with a controlled reconciliation error and no success-style completion footer; verify at least one additional sync flow inherits the same policy.

### Tests for User Story 2

- [x] T012 [US2] Add integration coverage for divergent `pull` failures, no-success-footer behavior, and one additional shared-policy consumer in `src/commands/__tests__/integration.test.ts`

### Implementation for User Story 2

- [x] T013 [US2] Apply shared fast-forward-only reconciliation and hard-failure command outcomes in `src/commands/pull.ts`
- [x] T014 [P] [US2] Apply shared reconciliation and controlled failure handling before vault writes in `src/commands/push.ts`
- [x] T015 [P] [US2] Apply shared reconciliation and controlled failure handling before re-encryption in `src/commands/key.ts`
- [x] T016 [US2] Align daemon-triggered pull and push behavior with the command-layer reconciliation policy in `src/daemon/index.ts`
- [x] T017 [US2] Update divergence behavior and recovery guidance in `docs/command-reference.md` and `docs/troubleshooting.md`
- [x] T018 [US2] Update the sync-flow explanation and Mermaid workflow coverage in `docs/architecture.md`

**Checkpoint**: User Story 2 is complete when divergence is handled consistently across manual and background sync flows and no failing reconciliation path reports success.

---

## Phase 5: User Story 3 - Maintainers can validate Git reconciliation behavior consistently (Priority: P3)

**Goal**: Make the command, architecture, and troubleshooting docs describe the same existing-vault bootstrap and divergence-recovery model.

**Independent Test**: Read the updated docs without code inspection and confirm they describe one consistent rule for existing-vault bootstrap, fast-forward-only updates, and divergence recovery.

### Implementation for User Story 3

- [x] T019 [US3] Perform a final consistency validation pass across `README.md`, `docs/command-reference.md`, `docs/troubleshooting.md`, and `docs/architecture.md` against the already-implemented reconciliation behavior
- [x] T020 [US3] Verify maintainer-facing consistency between repository docs, `specs/20260405-223110-fix-recipient-sync/quickstart.md`, and `specs/20260405-223110-fix-recipient-sync/contracts/vault-sync-workflow.md`

**Checkpoint**: User Story 3 is complete when the public docs and architecture explanation describe the same bootstrap and recovery workflow as the implemented command behavior.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Run final verification across implementation, documentation, and reviewer walkthrough artifacts.

- [x] T021 [P] Validate Mermaid diagrams changed by this feature in `docs/architecture.md` and `specs/20260405-223110-fix-recipient-sync/quickstart.md`
- [x] T022 [P] Execute the reviewer walkthrough in `specs/20260405-223110-fix-recipient-sync/quickstart.md`
- [x] T023 [P] Verify the implemented behavior against `specs/20260405-223110-fix-recipient-sync/contracts/vault-sync-workflow.md`
- [x] T024 [P] Execute a timed manual validation from `specs/20260405-223110-fix-recipient-sync/quickstart.md` confirming a reviewer can identify the blocker category, blocked sync action, and required recovery action within 60 seconds for SC-002
- [x] T025 [P] Fix exact remote ref inspection and mismatched remote URL handling in `src/core/git.ts` and `src/core/__tests__/git.test.ts`
- [x] T026 [P] Re-check recipient aliases after reconciliation and make key rotation transactional in `src/commands/key.ts` and `src/commands/__tests__/integration.test.ts`
- [x] T027 [P] Replace hand-written TOML fixture setup and clarify pre-fix reproduction guidance in `src/commands/__tests__/integration.test.ts` and `specs/20260405-223110-fix-recipient-sync/quickstart.md`
- [x] T028 [P] Execute targeted regression verification in `src/core/__tests__/git.test.ts` and `src/commands/__tests__/integration.test.ts`
- [x] T029 [P] Run `bun test --coverage` and confirm touched modules satisfy constitution thresholds
- [x] T030 [P] Update or verify JSDoc for exported symbols changed in `src/core/git.ts`, `src/commands/key.ts`, `src/commands/pull.ts`, `src/commands/push.ts`, and `src/daemon/index.ts`
- [ ] T031 Run `bun run check` from the repository root as the final repository-wide verification gate
- [x] T032 If T031 fails only because local npm is below `11.5.1`, record the blocker evidence from `src/commands/__tests__/packaging.test.ts` and mark it as an environment issue rather than unresolved feature behavior

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies; start immediately.
- **Phase 2 (Foundational)**: Depends on Phase 1; blocks all user stories.
- **Phase 3 (US1)**: Starts after Phase 2; delivers the existing-vault bootstrap MVP.
- **Phase 4 (US2)**: Starts after Phase 2; depends on the shared Git reconciliation helpers from T003-T004.
- **Phase 5 (US3)**: Starts after the paired runtime-and-documentation work in US1 and US2; focuses on final consistency validation and harmonization.
- **Phase 6 (Polish)**: Starts after all desired user stories are complete and now includes review-remediation tasks, coverage and JSDoc compliance checks, and the final repository-wide gate.

### User Story Dependencies

- **US1 (P1)**: Depends on T003-T004; no dependency on US2 or US3.
- **US2 (P2)**: Depends on T003-T004 and should follow US1 for `init`-related repository state assumptions.
- **US3 (P3)**: Depends on the documentation and runtime changes from US1 and US2 and validates their final consistency.

### Within Each User Story

- Test tasks should be written before corresponding implementation tasks.
- `src/commands/init.ts` tasks in US1 are sequential because they modify the same file.
- `push.ts` and `key.ts` tasks in US2 can proceed in parallel after `pull.ts` establishes the command-layer reconciliation outcome pattern.
- US1 documentation tasks T009-T011 should land with the `init` behavior changes they describe.
- US2 documentation tasks T017-T018 should land with the divergence-handling behavior changes they describe.

### Parallel Opportunities

- T001 and T002 can run in parallel during Setup.
- T014 and T015 can run in parallel during US2 because they modify different files.
- T021, T022, T023, T024, T025, T026, T027, T028, T029, and T030 can run in parallel during Polish before T031.
- T032 runs only if T031 fails solely because the local npm version does not satisfy the packaging test contract.

---

## Parallel Example: User Story 2

```bash
# Apply the shared reconciliation policy to independent sync writers together:
Task: "Apply shared reconciliation and controlled failure handling before vault writes in `src/commands/push.ts`"
Task: "Apply shared reconciliation and controlled failure handling before re-encryption in `src/commands/key.ts`"
```

## Parallel Example: User Story 3

```bash
# Run the final consistency checks in parallel before the repository-wide gate:
Task: "Validate Mermaid diagrams changed by this feature in `docs/architecture.md` and `specs/20260405-223110-fix-recipient-sync/quickstart.md`"
Task: "Execute the reviewer walkthrough in `specs/20260405-223110-fix-recipient-sync/quickstart.md`"
Task: "Verify the implemented behavior against `specs/20260405-223110-fix-recipient-sync/contracts/vault-sync-workflow.md`"
Task: "Execute a timed manual validation from `specs/20260405-223110-fix-recipient-sync/quickstart.md` confirming a reviewer can identify the blocker category, blocked sync action, and required recovery action within 60 seconds for SC-002"
Task: "Fix exact remote ref inspection and mismatched remote URL handling in `src/core/git.ts` and `src/core/__tests__/git.test.ts`"
Task: "Re-check recipient aliases after reconciliation and make key rotation transactional in `src/commands/key.ts` and `src/commands/__tests__/integration.test.ts`"
Task: "Replace hand-written TOML fixture setup and clarify pre-fix reproduction guidance in `src/commands/__tests__/integration.test.ts` and `specs/20260405-223110-fix-recipient-sync/quickstart.md`"
Task: "Execute targeted regression verification in `src/core/__tests__/git.test.ts` and `src/commands/__tests__/integration.test.ts`"
Task: "Run `bun test --coverage` and confirm touched modules satisfy constitution thresholds"
Task: "Update or verify JSDoc for exported symbols changed in `src/core/git.ts`, `src/commands/key.ts`, `src/commands/pull.ts`, `src/commands/push.ts`, and `src/daemon/index.ts`"
```

---

## Implementation Strategy

### MVP First

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. Validate second-machine bootstrap, including its paired docs, before expanding into broader divergence handling.

### Incremental Delivery

1. Deliver US1 to fix the existing-vault bootstrap failure on another laptop.
2. Deliver US2 to standardize divergence handling across manual and daemon sync flows while updating the paired docs in the same change.
3. Deliver US3 to harmonize and validate the final repository guidance against the plan artifacts.
4. Finish with Phase 6 verification against the quickstart and contract artifacts.

### Parallel Team Strategy

1. One contributor handles fixtures and `GitClient` foundational work.
2. One contributor handles `init` bootstrap behavior for US1.
3. One contributor handles `push` and `key` reconciliation changes after `pull` behavior is established.
4. One contributor handles the paired documentation updates within US1 and US2, then supports the final consistency pass.

---

## Notes

- All task lines use the required `- [ ] T### ...` checklist format.
- `[P]` is used only where tasks can proceed without touching the same file.
- The MVP scope is Phase 1 + Phase 2 + US1.
- This feature does not qualify for the documentation-only exception because runtime command behavior changes.
- T031 is currently blocked only by the local npm toolchain contract in `src/commands/__tests__/packaging.test.ts` at the `npm >= 11.5.1` assertion; `bun run check` and `bun test --coverage` otherwise pass feature validation and coverage thresholds for the touched modules.
