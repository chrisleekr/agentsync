# Tasks: Released CLI Documentation Refresh

**Input**: Design documents from `/specs/20260405-213451-released-cli-docs/`
**Prerequisites**: plan.md required, spec.md required, research.md, data-model.md, contracts/, quickstart.md

**Tests**: This feature qualifies for the constitution's documentation-only exception. No automated test tasks are added because the scope is limited to repository-hosted documentation and feature-planning artifacts. Validation still requires `bun run check` and the manual walkthrough recorded in `specs/20260405-213451-released-cli-docs/quickstart.md`.

**Organization**: Tasks are grouped by user story so each documentation outcome can be implemented and reviewed independently.

## Phase 1: Setup

**Purpose**: Review the feature contract and audit the current documentation surfaces before editing repository docs

- [X] T001 Review released CLI requirements and acceptance scenarios in `specs/20260405-213451-released-cli-docs/spec.md`, `specs/20260405-213451-released-cli-docs/plan.md`, and `specs/20260405-213451-released-cli-docs/contracts/released-cli-documentation-surface.md`
- [X] T002 Audit `README.md`, `docs/command-reference.md`, `docs/development.md`, `docs/maintenance.md`, and `docs/troubleshooting.md` against the released CLI contract to identify wording gaps for installation, usage, when-to-use routing, and canonical release references

---

## Phase 2: Foundational

**Purpose**: Confirm the shared validation rules that all documentation edits must satisfy

**⚠️ CRITICAL**: No user story work should be treated as complete until this phase is in place

- [X] T003 Review the documentation-only validation expectations in `specs/20260405-213451-released-cli-docs/quickstart.md` and the constitution exception recorded in `specs/20260405-213451-released-cli-docs/spec.md`
- [X] T004 Confirm that GitHub Releases remains the canonical release-information source across the affected documentation surfaces before editing begins

**Checkpoint**: Audit findings and shared validation rules are established

---

## Phase 3: User Story 1 - Released users find the published command path quickly (Priority: P1) 🎯 MVP

**Goal**: Make the released CLI path clear for installation, first verification, and first use

**Independent Test**: Open `README.md` and `docs/command-reference.md` as a first-time released user and confirm they show the published invocation path, the first verification command, and the canonical release-information source without requiring source-only docs first

### Implementation for User Story 1

- [X] T005 [P] [US1] Update `README.md` with released CLI prerequisites, installation or invocation guidance, and the first verification command
- [X] T006 [P] [US1] Update `docs/command-reference.md` with the published `bunx --package @chrisleekr/agentsync agentsync ...` invocation rule and released support-state wording
- [X] T007 [US1] Align `README.md` and `docs/command-reference.md` around when to use the released CLI path and where to find GitHub Releases

**Checkpoint**: Released users can identify how to invoke the published CLI and where to confirm release details

---

## Phase 4: User Story 2 - Supporting docs keep released and source workflows distinct (Priority: P2)

**Goal**: Make the released-versus-source workflow boundary explicit in contributor-facing and troubleshooting docs

**Independent Test**: Open `docs/development.md` and `docs/troubleshooting.md` directly and confirm each page labels its workflow scope clearly and redirects released users before they follow source-only commands

### Implementation for User Story 2

- [X] T008 [P] [US2] Update `docs/development.md` with an explicit contributor-from-source scope note and redirect released users to `README.md` and `docs/command-reference.md`
- [X] T009 [P] [US2] Update `docs/troubleshooting.md` so source-only command examples are scoped correctly and released users are redirected before following them
- [X] T010 [US2] Align `docs/development.md` and `docs/troubleshooting.md` so the released-versus-source boundary and redirect wording are consistent

**Checkpoint**: Deep-linked contributors and operators can tell whether they should use released or source-based commands

---

## Phase 5: User Story 3 - Reviewers can validate the change as documentation-only (Priority: P3)

**Goal**: Make documentation-only review criteria explicit so maintainers can confirm scope and consistency quickly

**Independent Test**: Open `docs/maintenance.md` and `specs/20260405-213451-released-cli-docs/quickstart.md` and confirm they define the same reviewer checks for documentation-only scope, affected docs, and canonical release-information validation

### Implementation for User Story 3

- [X] T011 [P] [US3] Update `docs/maintenance.md` release workflow ownership rules to list `README.md`, `docs/command-reference.md`, `docs/development.md`, `docs/maintenance.md`, and `docs/troubleshooting.md` as the released-path docs that must stay aligned
- [X] T012 [P] [US3] Update `specs/20260405-213451-released-cli-docs/quickstart.md` with the final reviewer-facing manual walkthrough order for the affected documentation surfaces
- [X] T013 [US3] Align `docs/maintenance.md` and `specs/20260405-213451-released-cli-docs/quickstart.md` so documentation-only review criteria and canonical release checks match

**Checkpoint**: Reviewers can verify the scope and consistency of the documentation-only change without inspecting runtime code

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final verification across all documentation surfaces

- [X] T014 [P] Run `bun run check` before final review
- [X] T015 Execute the manual walkthrough in `specs/20260405-213451-released-cli-docs/quickstart.md` against `README.md`, `docs/command-reference.md`, `docs/development.md`, `docs/maintenance.md`, and `docs/troubleshooting.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies and can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion and blocks story completion until shared rules and walkthrough expectations are set
- **User Story 1 (Phase 3)**: Depends on Foundational completion and delivers the MVP released-user path
- **User Story 2 (Phase 4)**: Depends on Foundational completion and can proceed independently of User Story 1 once shared rules are set
- **User Story 3 (Phase 5)**: Depends on Foundational completion; its final alignment task should run after the reviewer-facing edits for the other stories have settled
- **Polish (Phase 6)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: No dependency on other user stories after Foundational
- **User Story 2 (P2)**: No dependency on User Story 1 after Foundational, but both stories must preserve matching terminology
- **User Story 3 (P3)**: No dependency on runtime behavior changes because the feature is documentation-only, but its final review-alignment task depends on the documentation surfaces being up to date

### Within Each User Story

- Update the primary target files first
- Reconcile cross-links and wording after the primary edits land
- Confirm the story's independent test before moving on

### Parallel Opportunities

- `T005` and `T006` can run in parallel because they target different files
- `T008` and `T009` can run in parallel because they target different files
- `T011` and `T012` can run in parallel because they target different files
- `T014` can run in parallel with final manual review preparation once all documentation edits are complete

---

## Parallel Example: User Story 1

```bash
# Launch the released-user documentation updates together:
Task: "Update README.md with released CLI prerequisites, installation or invocation guidance, and the first verification command"
Task: "Update docs/command-reference.md with the published bunx invocation rule and released support-state wording"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Confirm released users can identify install, invocation, and release lookup from `README.md` and `docs/command-reference.md`

### Incremental Delivery

1. Complete Setup + Foundational to lock the documentation rules and walkthrough path
2. Deliver User Story 1 and validate the released-user path
3. Deliver User Story 2 and validate released-versus-source routing for contributors and operators
4. Deliver User Story 3 and validate reviewer-facing documentation-only checks
5. Finish with `bun run check` and the manual walkthrough

### Parallel Team Strategy

With multiple contributors:

1. One contributor updates `README.md` while another updates `docs/command-reference.md`
2. After User Story 1, split `docs/development.md` and `docs/troubleshooting.md` between contributors
3. Finish by reconciling `docs/maintenance.md` and `specs/20260405-213451-released-cli-docs/quickstart.md` for reviewer validation

---

## Notes

- `[P]` tasks target different files and do not depend on unfinished work in the same phase
- No automated test tasks are included because the feature qualifies for the documentation-only exception recorded in the spec and plan
