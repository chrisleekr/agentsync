# Tasks: Release Project for Bunx Installation

**Input**: Design documents from `/specs/20260405-112827-bunx-release/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅, quickstart.md ✅

**Tests**: Release-surface validation tasks are included because the plan and constitution require packaging and workflow verification for this feature.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[US1/US2/US3]**: User story label for traceability

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add the shared Node publish-toolchain pins needed by release validation and contributor setup across all stories.

- [x] T001 [P] Add the Node publish-toolchain pin in .nvmrc
- [x] T002 [P] Add the matching Volta Node pin in package.json

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the shared release validation scaffolding that every user story depends on.

**⚠️ CRITICAL**: No user story should be considered complete until T003-T004 are done.

- [x] T003 [P] Create the package release smoke-test scaffolding in `src/commands/__tests__/packaging.test.ts`
- [x] T004 [P] Establish shared package build and validation script scaffolding in package.json

**Checkpoint**: The repo has the shared Node toolchain pin, packaging test scaffold, and build/validation script scaffold needed for install, publish, and documentation work.

---

## Phase 3: User Story 1 - Install Without Cloning The Repository (Priority: P1) 🎯 MVP

**Goal**: Make the published package installable through the documented `bunx` command without requiring a repository checkout.

**Independent Test**: Run the packaging smoke tests and inspect `npm pack --dry-run`; after the first publish, confirm `bunx --package @chrisleekr/agentsync agentsync --version` starts the released CLI and reports the expected version.

### Tests for User Story 1

- [x] T005 [US1] Add publish-blocker, tarball-shape, bin-target, and version-alignment assertions in `src/commands/__tests__/packaging.test.ts`

### Implementation for User Story 1

- [x] T006 [US1] Convert the package identity and public npm metadata to the scoped release surface in package.json
- [x] T007 [US1] Wire the published `bin`, `files` allowlist, and `build:package` output for `dist/cli.js` in package.json
- [x] T008 [P] [US1] Preserve the Bun shebang and CLI version behavior required by the published package in src/cli.ts

**Checkpoint**: User Story 1 is complete when the package tarball is publishable, contains the expected Bun-native executable, and the documented install command can resolve the released CLI.

---

## Phase 4: User Story 2 - Publish A Release Users Can Actually Consume (Priority: P1)

**Goal**: Extend the release workflow so a created release also publishes the npm package through OIDC-only trusted publishing.

**Independent Test**: Inspect the release workflow and confirm it uses GitHub-hosted runners, `id-token: write`, exact Node/npm requirements, and no long-lived npm write token fallback; then verify the released version is installable via the documented `bunx` command.

### Tests for User Story 2

- [x] T009 [P] [US2] Add OIDC publish-permission and hosted-runner assertions in `src/commands/__tests__/release-workflow.test.ts`

### Implementation for User Story 2

- [x] T010 [US2] Add the OIDC-only npm publish job with exact Node and npm requirements in .github/workflows/release-please.yml
- [x] T011 [P] [US2] Upgrade the remaining Bun dependency cache steps to actions/cache@v5 in .github/workflows/ci.yml

**Checkpoint**: User Story 2 is complete when release-please can publish the npm package through OIDC without relying on long-lived npm credentials and CI cache usage is aligned with the release workflow.

---

## Phase 5: User Story 3 - Understand The Released Usage Path Quickly (Priority: P2)

**Goal**: Make the released-user, contributor, and maintainer documentation paths explicit, accurate, and consistent.

**Independent Test**: Open the repository docs without reading source code; a user should be able to find the install command and prerequisites, a contributor should understand the Bun and Node toolchains, and a maintainer should find the OIDC-only release workflow.

### Implementation for User Story 3

- [x] T012 [P] [US3] Draft README.md updates that separate released-user `bunx` usage from contributor setup from source without making final support claims before validation
- [x] T013 [P] [US3] Draft docs/development.md updates for Bun runtime and Node publish-toolchain expectations without depending on final publish validation wording
- [x] T014 [P] [US3] Draft docs/command-reference.md updates for the install command, prerequisites, verification step, and command usage path without making final support claims before validation
- [x] T015 [P] [US3] Draft docs/maintenance.md updates for the OIDC-only maintainer release flow and upkeep steps
- [x] T016 [US3] Add release-information guidance and GitHub Release note links in README.md and docs/command-reference.md
- [x] T017 [US3] Finalize supported install wording, release-information guidance, prerequisites, and cross-links across README.md, docs/development.md, docs/command-reference.md, and docs/maintenance.md after US1 and US2 validation succeeds

**Checkpoint**: User Story 3 is complete when the four documentation files describe the same validated release path, point users to the canonical release-information surface, and avoid premature support claims before validation.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Run the final release-readiness and contract-compliance checks across all stories.

- [ ] T018 [P] Run the end-to-end validation checklist in specs/20260405-112827-bunx-release/quickstart.md
- [ ] T019 [P] Verify the implemented package, workflow, docs, and release-information surface satisfy specs/20260405-112827-bunx-release/contracts/release-surface.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies; start immediately.
- **Phase 2 (Foundational)**: Depends on Phase 1; blocks all user stories.
- **Phase 3 (US1)**: Starts after Phase 2; delivers the installable package MVP.
- **Phase 4 (US2)**: Starts after Phase 2; can proceed in parallel with US1 and US3 because it focuses on workflows.
- **Phase 5 (US3)**: Draft documentation work starts after Phase 2 and can proceed in parallel with US1 and US2, but T017 must wait for validated install and publish behavior.
- **Phase 6 (Polish)**: Starts after all desired user stories are complete.

### User Story Dependencies

- **US1 (P1)**: Depends on T003-T004; no dependency on US2 or US3.
- **US2 (P1)**: Depends on T003-T004; no dependency on US1 or US3 for workflow implementation.
- **US3 (P2)**: Depends on T003-T004 for draft documentation work; final wording alignment in T017 depends on validated install and publish behavior from US1 and US2.

### Within Each User Story

- Test tasks should be written before the corresponding implementation tasks when present.
- `package.json` tasks in US1 are sequential because they modify the same file.
- Workflow tasks in US2 should keep the test file and CI cache update separate from the publish job change.
- Documentation draft tasks T012-T015 can run in parallel, T016 adds release-information guidance after README and command-reference drafts exist, and T017 finalizes wording only after US1 and US2 validation.

### Parallel Opportunities

- T001 and T002 can run in parallel during Setup.
- T003 and T004 can run in parallel during Foundational.
- In US1, T005 and T008 can run in parallel after Foundational because they touch different files.
- In US2, T009 and T011 can run in parallel while T010 remains the central workflow change.
- In US3, T012-T015 can run in parallel because they touch different documentation files.
- T018 and T019 can run in parallel during the final validation phase.

---

## Parallel Example: User Story 1

```bash
# Prepare install validation and CLI entry behavior together:
Task: "Add publish-blocker, tarball-shape, bin-target, and version-alignment assertions in `src/commands/__tests__/packaging.test.ts`"
Task: "Preserve the Bun shebang and CLI version behavior required by the published package in src/cli.ts"
```

## Parallel Example: User Story 2

```bash
# Prepare workflow validation and CI cache alignment together:
Task: "Add OIDC publish-permission and hosted-runner assertions in `src/commands/__tests__/release-workflow.test.ts`"
Task: "Upgrade the remaining Bun dependency cache steps to actions/cache@v5 in .github/workflows/ci.yml"
```

## Parallel Example: User Story 3

```bash
# Split the documentation work by audience:
Task: "Draft README.md updates that separate released-user bunx usage from contributor setup from source without making final support claims before validation"
Task: "Draft docs/development.md updates for Bun runtime and Node publish-toolchain expectations without depending on final publish validation wording"
Task: "Draft docs/command-reference.md updates for the install command, prerequisites, verification step, and command usage path without making final support claims before validation"
Task: "Draft docs/maintenance.md updates for the OIDC-only maintainer release flow and upkeep steps"

# After the draft tasks, finish the shared documentation alignment:
Task: "Add release-information guidance and GitHub Release note links in README.md and docs/command-reference.md"
Task: "Finalize supported install wording, release-information guidance, prerequisites, and cross-links across README.md, docs/development.md, docs/command-reference.md, and docs/maintenance.md after US1 and US2 validation succeeds"
```

---

## Implementation Strategy

### MVP First

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. Validate the installable package surface before expanding into workflow automation and docs.

### Incremental Delivery

1. Deliver US1 to make the package installable through the documented `bunx` path.
2. Deliver US2 to make releases publishable and consumable through OIDC-only automation.
3. Deliver US3 to make the user, contributor, and maintainer docs consistent with the validated release surface and the canonical release-information source.
4. Finish with Phase 6 validation against the quickstart and contract artifacts.

### Parallel Team Strategy

1. One contributor handles package/test work for US1.
2. One contributor handles workflow automation for US2.
3. One contributor handles the four documentation files for US3.
4. Rejoin for the final quickstart and contract validation tasks.

---

## Notes

- All task lines use the required `- [ ] T### ...` checklist format.
- `[P]` is used only for tasks that can proceed in parallel without editing the same file.
- The MVP scope is Phase 1 + Phase 2 + US1.
- US3 is kept as a separate documentation story so user, contributor, and maintainer guidance can be reviewed independently of the release workflow changes.
