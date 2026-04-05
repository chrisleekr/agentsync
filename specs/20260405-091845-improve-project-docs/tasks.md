# Tasks: Improve Project Documentation

**Input**: Design documents from `/specs/20260405-091845-improve-project-docs/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅, quickstart.md ✅

**Tests**: No dedicated test-first tasks are generated for this feature. The spec asks for documentation and JSDoc outcomes, with validation through manual story checks plus `bun run check`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[US1/US2/US3/US4]**: User story label for traceability

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Audit the current documentation and code-comment surface so implementation starts from verified repository reality instead of assumptions.

- [X] T001 Audit current entry-point and onboarding coverage in README.md and src/cli.ts
- [X] T002 [P] Audit current operator workflow coverage in src/commands/init.ts, src/commands/push.ts, src/commands/pull.ts, src/commands/status.ts, src/commands/doctor.ts, src/commands/daemon.ts, and src/commands/key.ts
- [X] T003 [P] Audit JSDoc gaps and stale comments in src/agents/\_utils.ts, src/commands/shared.ts, src/config/loader.ts, src/core/git.ts, src/core/sanitizer.ts, src/daemon/index.ts, src/lib/debug.ts, and src/test-helpers/fixtures.ts

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the shared documentation structure and language rules that all user stories depend on.

**⚠️ CRITICAL**: No user story should be considered complete until T004-T006 are done.

- [X] T004 Create focused documentation shells in docs/development.md, docs/architecture.md, docs/maintenance.md, docs/command-reference.md, and docs/troubleshooting.md
- [X] T005 Establish shared terminology and concise-writing boundaries in README.md, docs/development.md, docs/architecture.md, docs/maintenance.md, docs/command-reference.md, and docs/troubleshooting.md
- [X] T006 Build the shared cross-link structure and section headings in README.md, docs/development.md, docs/architecture.md, docs/maintenance.md, docs/command-reference.md, and docs/troubleshooting.md

**Checkpoint**: The documentation set has stable page skeletons, shared terminology, and navigation expectations. User story work can proceed without redefining structure.

---

## Phase 3: User Story 1 - New Contributor Reaches First Success Quickly (Priority: P1) 🎯 MVP

**Goal**: A new contributor can understand the project, set up locally, and complete the first documented workflow without reading source.

**Independent Test**: Open README.md, follow the onboarding path into docs/development.md, and use docs/troubleshooting.md only if needed. A new contributor should be able to identify prerequisites, run setup, and complete the initial workflow without extra guidance.

### Implementation for User Story 1

- [X] T007 [P] [US1] Write the concise project overview, prerequisites, and first-run path in README.md
- [X] T008 [P] [US1] Write contributor setup, install, check, and local workflow guidance in docs/development.md
- [X] T009 [P] [US1] Add setup and environment recovery guidance for common onboarding failures in docs/troubleshooting.md
- [X] T010 [US1] Connect the onboarding journey across README.md, docs/development.md, and docs/troubleshooting.md with explicit next-step links

**Checkpoint**: User Story 1 is complete when a first-time contributor can move from the repository landing page to a successful local workflow using only README.md, docs/development.md, and docs/troubleshooting.md.

---

## Phase 4: User Story 2 - Operator Finds Accurate Usage Guidance (Priority: P2)

**Goal**: Existing users can quickly identify the right command, required inputs, expected outcomes, and operational caveats for supported workflows.

**Independent Test**: Pick any supported task from init, push, pull, status, doctor, daemon, or key. The reader should be able to find the correct section in under 2 minutes and understand when to use the command, what it needs, and what to expect.

### Implementation for User Story 2

- [X] T011 [P] [US2] Write command purpose, required inputs, expected results, and workflow selection guidance in docs/command-reference.md
- [X] T012 [P] [US2] Add platform-specific caveats and safe handling guidance for keys and sensitive configuration in docs/command-reference.md and docs/troubleshooting.md
- [X] T013 [US2] Add operator navigation from README.md to docs/command-reference.md and docs/troubleshooting.md

**Checkpoint**: User Story 2 is complete when each user-facing command is documented as an operator lookup path and common operational mistakes are called out before failure.

---

## Phase 5: User Story 4 - README Serves As The Canonical Entry Point (Priority: P2)

**Goal**: The README becomes a compact landing page with the logo, project identity, setup path, and direct links to deeper guides.

**Independent Test**: Open README.md on its own. The user should be able to recognize the project, see the logo, understand the quick-start path, and reach development, architecture, maintenance, command, and troubleshooting guidance in one click.

### Implementation for User Story 4

- [X] T014 [P] [US4] Embed docs/agentsync-logo.png with meaningful alt text and add the concise landing section in README.md
- [X] T015 [P] [US4] Add the one-screen documentation map in README.md linking docs/development.md, docs/architecture.md, docs/maintenance.md, docs/command-reference.md, and docs/troubleshooting.md
- [X] T016 [US4] Tighten README.md so deeper detail is routed into supporting guides without losing the primary setup path

**Checkpoint**: User Story 4 is complete when README.md works as the canonical entry page rather than a partial overview that forces readers into the source tree.

---

## Phase 6: User Story 3 - Maintainer Keeps Docs Current As Features Change (Priority: P3)

**Goal**: Maintainers can update the right docs consistently and see concise reasoning-led JSDoc across maintained TypeScript source.

**Independent Test**: Ask a maintainer to change a documented workflow and inspect the repo. They should be able to find the update rules in docs/maintenance.md, understand the system map from docs/architecture.md, and see concise JSDoc immediately above maintained exports and workflow-significant helpers in representative source files.

### Implementation for User Story 3

- [X] T017 [P] [US3] Write the module map, sync flow, security boundaries, and daemon relationships in docs/architecture.md
- [X] T018 [P] [US3] Write documentation upkeep rules, JSDoc expectations, and review checklist in docs/maintenance.md
- [X] T019 [P] [US3] Add or normalize concise reasoning-led JSDoc in src/agents/\_utils.ts, src/agents/claude.ts, src/agents/codex.ts, src/agents/copilot.ts, src/agents/cursor.ts, src/agents/registry.ts, and src/agents/vscode.ts
- [X] T020 [P] [US3] Add or normalize concise reasoning-led JSDoc in src/cli.ts, src/commands/daemon.ts, src/commands/doctor.ts, src/commands/init.ts, src/commands/key.ts, src/commands/pull.ts, src/commands/push.ts, src/commands/shared.ts, and src/commands/status.ts
- [X] T021 [P] [US3] Add or normalize concise reasoning-led JSDoc in src/config/loader.ts, src/config/paths.ts, src/config/schema.ts, src/core/encryptor.ts, src/core/git.ts, src/core/ipc.ts, src/core/sanitizer.ts, src/core/tar.ts, and src/core/watcher.ts
- [X] T022 [P] [US3] Add or normalize concise reasoning-led JSDoc in src/daemon/index.ts, src/daemon/installer-linux.ts, src/daemon/installer-macos.ts, src/daemon/installer-windows.ts, src/lib/debug.ts, and src/test-helpers/fixtures.ts
- [X] T023 [US3] Align maintainer terminology and source-of-truth links across README.md, docs/architecture.md, docs/maintenance.md, docs/development.md, docs/command-reference.md, and docs/troubleshooting.md

**Checkpoint**: User Story 3 is complete when maintainers have explicit upkeep guidance and maintained TypeScript source reads consistently with concise JSDoc.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Validate the full documentation system for concision, consistency, and repository health.

- [X] T024 [P] Review README.md, docs/development.md, docs/architecture.md, docs/maintenance.md, docs/command-reference.md, and docs/troubleshooting.md for concision, non-duplication, and consistent terminology
- [X] T025 [P] Run the repository validation defined in package.json with `bun run check` from package.json
- [X] T026 [P] Spot-check concise JSDoc quality in src/agents/registry.ts, src/commands/init.ts, src/core/git.ts, src/daemon/index.ts, and src/lib/debug.ts
- [X] T027 Run the completion checklist in specs/20260405-091845-improve-project-docs/quickstart.md against README.md and docs/development.md, docs/architecture.md, docs/maintenance.md, docs/command-reference.md, and docs/troubleshooting.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies; start immediately.
- **Phase 2 (Foundational)**: Depends on Phase 1; blocks all user stories.
- **Phase 3 (US1)**: Starts after Phase 2; delivers the MVP onboarding path.
- **Phase 4 (US2)**: Starts after Phase 2; can run in parallel with US4 and most of US3.
- **Phase 5 (US4)**: Starts after Phase 2; can run in parallel with US2 and most of US3.
- **Phase 6 (US3)**: Starts after Phase 2; its JSDoc batches can run in parallel once docs/maintenance.md and docs/architecture.md are underway.
- **Phase 7 (Polish)**: Starts after all desired user stories are complete.

### User Story Dependencies

- **US1 (P1)**: Depends only on the shared documentation skeleton and navigation rules from T004-T006.
- **US2 (P2)**: Depends on the shared documentation skeleton and can proceed independently of US1 once docs/command-reference.md and docs/troubleshooting.md exist.
- **US4 (P2)**: Depends on the shared documentation skeleton and should land after T004-T006 so README links point at real guides.
- **US3 (P3)**: Depends on the shared documentation skeleton; docs/architecture.md and docs/maintenance.md should be drafted before the JSDoc batches finish.

### Within Each User Story

- Write or update the primary guide content before wiring final navigation links.
- Complete broad document structure before polishing concision.
- For US3, finish docs/architecture.md and docs/maintenance.md before the final terminology-alignment task.
- For US3 JSDoc work, each directory batch can proceed independently, but all batches must be complete before T023 and the Phase 7 spot-check.

### Parallel Opportunities

- T002 and T003 can run in parallel during Setup.
- T004-T006 are shared-document structure tasks and should be done sequentially.
- T007-T009 can run in parallel for US1.
- T011 and T012 can run in parallel for US2.
- T014 and T015 can run in parallel for US4.
- T017 and T018 can run in parallel for US3.
- T019-T022 can run in parallel for US3 because they touch different source-file groups.
- T024-T026 can run in parallel in Polish.

---

## Parallel Example: User Story 1

```bash
# Launch the contributor-facing content work together:
Task: "Write the concise project overview, prerequisites, and first-run path in README.md"
Task: "Write contributor setup, install, check, and local workflow guidance in docs/development.md"
Task: "Add setup and environment recovery guidance for common onboarding failures in docs/troubleshooting.md"
```

## Parallel Example: User Story 2

```bash
# Build operator lookup material together:
Task: "Write command purpose, required inputs, expected results, and workflow selection guidance in docs/command-reference.md"
Task: "Add platform-specific caveats and safe handling guidance for keys and sensitive configuration in docs/command-reference.md and docs/troubleshooting.md"
```

## Parallel Example: User Story 4

```bash
# Build the README landing experience together:
Task: "Embed docs/agentsync-logo.png with meaningful alt text and add the concise landing section in README.md"
Task: "Add the one-screen documentation map in README.md linking docs/development.md, docs/architecture.md, docs/maintenance.md, docs/command-reference.md, and docs/troubleshooting.md"
```

## Parallel Example: User Story 3

```bash
# Split the JSDoc rollout by source area:
Task: "Add or normalize concise reasoning-led JSDoc in src/agents/_utils.ts, src/agents/claude.ts, src/agents/codex.ts, src/agents/copilot.ts, src/agents/cursor.ts, src/agents/registry.ts, and src/agents/vscode.ts"
Task: "Add or normalize concise reasoning-led JSDoc in src/cli.ts, src/commands/daemon.ts, src/commands/doctor.ts, src/commands/init.ts, src/commands/key.ts, src/commands/pull.ts, src/commands/push.ts, src/commands/shared.ts, and src/commands/status.ts"
Task: "Add or normalize concise reasoning-led JSDoc in src/config/loader.ts, src/config/paths.ts, src/config/schema.ts, src/core/encryptor.ts, src/core/git.ts, src/core/ipc.ts, src/core/sanitizer.ts, src/core/tar.ts, and src/core/watcher.ts"
Task: "Add or normalize concise reasoning-led JSDoc in src/daemon/index.ts, src/daemon/installer-linux.ts, src/daemon/installer-macos.ts, src/daemon/installer-windows.ts, src/lib/debug.ts, and src/test-helpers/fixtures.ts"
```

---

## Implementation Strategy

### MVP First

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. Validate the onboarding path through README.md, docs/development.md, and docs/troubleshooting.md before expanding scope.

### Incremental Delivery

1. Deliver US1 to unblock contributor onboarding.
2. Deliver US2 to cover day-to-day operator workflows.
3. Deliver US4 to make README.md the canonical landing page for the full doc set.
4. Deliver US3 to lock in long-term maintainability with docs/architecture.md, docs/maintenance.md, and repo-wide JSDoc coverage.
5. Finish with Phase 7 validation.

### Parallel Team Strategy

1. One contributor handles README.md plus onboarding docs after Phase 2.
2. One contributor handles docs/command-reference.md plus docs/troubleshooting.md operator detail.
3. One contributor handles docs/architecture.md, docs/maintenance.md, and the JSDoc rollout batches.
4. Rejoin for Phase 7 consistency review and `bun run check`.

---

## Notes

- [P] tasks avoid incomplete-task dependencies and mostly separate file groups.
- User story phases are organized for independent delivery and validation.
- JSDoc rollout is grouped by source area to keep edits reviewable.
- Phase 7 is the point where repository checks and whole-doc consistency are enforced.
