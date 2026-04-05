# Tasks: Improve Speckit Development Documentation

**Input**: Design documents from `/specs/20260405-195011-speckit-dev-docs/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/, quickstart.md

**Tests**: No new automated test tasks are required by the specification. Validation is handled through walkthrough checks, Mermaid validation, and repository-wide verification.

**Organization**: Tasks are grouped by user story so each documentation outcome can be implemented and validated independently.

## Phase 1: Setup

**Purpose**: Create the target documentation files and shared working structure.

- [x] T001 Create docs/speckit.md with contract-aligned section headings for prerequisites, workflow stages, Mermaid flow, artifacts, examples, and resume guidance
- [x] T002 Create docs/speckit-local-development.md with contract-aligned section headings for repo surfaces, branch mapping, validation, and recovery guidance

---

## Phase 2: Foundational

**Purpose**: Establish shared navigation and terminology before user-story content is filled in.

**⚠️ CRITICAL**: User story work should build on this shared navigation layer to avoid conflicting terminology and broken links.

- [x] T003 Update README.md to add entry-point navigation for docs/speckit.md and docs/speckit-local-development.md
- [x] T004 [P] Update docs/development.md and docs/maintenance.md to adopt shared speckit terminology and cross-links to docs/speckit.md and docs/speckit-local-development.md

**Checkpoint**: The repo now has visible navigation targets and a shared vocabulary for the new guides.

---

## Phase 3: User Story 1 - Start A Speckit Feature Confidently (Priority: P1) 🎯 MVP

**Goal**: Give first-time contributors a clear start path, command-by-command guidance, and an official-process Mermaid overview.

**Independent Test**: Open README.md, follow the link to docs/speckit.md, identify the first command to run, the first artifact expected, the next step after specification, and confirm the Mermaid diagram matches the official quickstart order.

### Implementation for User Story 1

- [x] T005 [US1] Write setup modes, prerequisites, and first-run guidance in docs/speckit.md from the official installation and quickstart sources
- [x] T006 [US1] Document the mainline workflow stages and command-by-command when/how/next-step guidance in docs/speckit.md
- [x] T007 [US1] Add and validate the official-process Mermaid workflow diagram in docs/speckit.md
- [x] T008 [US1] Add AgentSync-specific constitution, specify, clarify, plan, tasks, analyze, and implement examples with expected artifacts in docs/speckit.md
- [x] T009 [P] [US1] Refine README.md quick-start wording to surface the first command and first expected artifact from docs/speckit.md

**Checkpoint**: A first-time contributor can discover the guide, understand how to start, and follow the official workflow visually and textually.

---

## Phase 4: User Story 2 - Understand Artifact Roles And Quality Gates (Priority: P2)

**Goal**: Help maintainers and reviewers understand what each artifact does, when a stage is ready, and how to assess completeness.

**Independent Test**: Open docs/speckit.md, docs/speckit-local-development.md, and docs/maintenance.md, then explain what `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`, and `tasks.md` are for, when a feature is ready for the next stage, how `/speckit.checklist` and `/speckit.analyze` fit in, and who is expected to update the docs when workflow behavior changes.

### Implementation for User Story 2

- [x] T010 [US2] Add the feature artifact map for spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md, and tasks.md in docs/speckit.md
- [x] T011 [US2] Add readiness signals and stage transition rules for specify, clarify, plan, tasks, analyze, and implement in docs/speckit.md
- [x] T012 [P] [US2] Add a maintainer review rubric for artifact completeness and quality in docs/maintenance.md
- [x] T013 [US2] Update docs/speckit.md and docs/maintenance.md to explain when to use optional /speckit.checklist and /speckit.analyze validation paths
- [x] T014 [US2] Document ownership and update triggers in docs/maintenance.md and docs/speckit-local-development.md, including who updates speckit guidance, when workflow, template, or governance changes require doc updates, and how upstream spec-kit drift is checked

**Checkpoint**: Reviewers can evaluate artifact purpose, readiness, and optional validation steps without reading source code.

---

## Phase 5: User Story 3 - Resolve Common Speckit Workflow Confusion (Priority: P3)

**Goal**: Give contributors and maintainers clear recovery guidance for repo-local workflow confusion, resuming work, and advanced customization boundaries.

**Independent Test**: Open docs/speckit-local-development.md and, if present, docs/troubleshooting.md, then identify how active feature detection works, how timestamp branches map to feature directories, how to resume an existing feature, and what to do when `.specify/extensions.yml` is absent.

### Implementation for User Story 3

- [x] T015 [US3] Write the repo-local surface map for .github/prompts, .github/agents, and .specify in docs/speckit-local-development.md
- [x] T016 [US3] Add active-feature detection, timestamp branch mapping, and resume or rerun guidance in docs/speckit-local-development.md
- [x] T017 [US3] Update docs/speckit.md and docs/speckit-local-development.md to explain baseline workflow versus extensions and presets when .specify/extensions.yml is absent
- [x] T018 [US3] Add stage-selection, incomplete-artifact, and official-source drift recovery guidance in docs/speckit-local-development.md, and add a brief pointer in docs/troubleshooting.md if needed for discoverability

**Checkpoint**: Contributors can recover from common workflow confusion and maintain the local speckit setup without tribal knowledge.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final consistency review, walkthrough validation, and repo-wide verification.

- [x] T019 [P] Review README.md, docs/speckit.md, docs/speckit-local-development.md, docs/development.md, docs/maintenance.md, and docs/troubleshooting.md for consistent terminology and cross-links
- [x] T020 Validate the Mermaid flowchart in docs/speckit.md against the ordering documented in specs/20260405-195011-speckit-dev-docs/research.md
- [x] T021 Run the walkthrough scenarios in specs/20260405-195011-speckit-dev-docs/quickstart.md against README.md, docs/speckit.md, and docs/speckit-local-development.md
- [ ] T022 Run bun run check from package.json and fix any markdown or lint issues caused by README.md and docs/ updates

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion; establishes shared navigation and vocabulary.
- **User Stories (Phases 3-5)**: Depend on Foundational completion.
- **Polish (Phase 6)**: Depends on the desired user stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Starts after Foundational completion and delivers the MVP documentation path.
- **User Story 2 (P2)**: Starts after Foundational completion; touches docs/speckit.md and docs/maintenance.md, so in single-threaded execution it is safest after US1.
- **User Story 3 (P3)**: Starts after Foundational completion; can run alongside later US1 or US2 work if file ownership is coordinated.

### Within Each User Story

- Core guide content before cross-file wording refinements.
- Mermaid authoring before Mermaid validation.
- Artifact explanations before readiness and rubric polishing.
- Repo-local recovery guidance before troubleshooting polish.

### Parallel Opportunities

- T004 can run in parallel with T003 after the two new guide files exist.
- T009 can run in parallel with late US1 guide drafting because it touches README.md instead of docs/speckit.md.
- T012 can run in parallel with T010-T011 because it only touches docs/maintenance.md.
- T019 can run in parallel with other late polish work if content is already stable.
- No direct same-story parallel path remains in US3 because T015-T018 now converge on docs/speckit-local-development.md.

---

## Parallel Example: User Story 1

```bash
# After the core guide structure exists, these can proceed in parallel:
Task: "Refine README.md quick-start wording to surface the first command and first expected artifact from docs/speckit.md"
Task: "Add AgentSync-specific constitution, specify, clarify, plan, tasks, analyze, and implement examples with expected artifacts in docs/speckit.md"
```

---

## Parallel Example: User Story 2

```bash
# These can proceed in parallel once the shared terminology foundation is in place:
Task: "Add a maintainer review rubric for artifact completeness and quality in docs/maintenance.md"
Task: "Add the feature artifact map for spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md, and tasks.md in docs/speckit.md"
```

---

## Parallel Example: User Story 3

```bash
# No direct same-story parallel pair remains after consolidating recovery guidance into docs/speckit-local-development.md:
Task: "Write the repo-local surface map for .github/prompts, .github/agents, and .specify in docs/speckit-local-development.md"
Task: "Then continue sequentially with active-feature, extensions, and recovery guidance in docs/speckit-local-development.md"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. Stop and validate that README.md and docs/speckit.md let a new contributor start confidently.

### Incremental Delivery

1. Finish Setup + Foundational to establish the new documentation surfaces.
2. Deliver User Story 1 as the onboarding MVP.
3. Add User Story 2 to support reviewers and maintainers.
4. Add User Story 3 to cover local maintenance and troubleshooting.
5. Finish with Phase 6 walkthrough and repository validation.

### Parallel Team Strategy

1. One contributor establishes the two new guide files and README.md navigation.
2. A second contributor can work on docs/maintenance.md while the main guide is being filled out.
3. A third contributor can prepare a short docs/troubleshooting.md pointer after the local-development recovery guidance is stable.

---

## Notes

- `[P]` tasks touch different files and can be coordinated safely in parallel.
- `[US1]`, `[US2]`, and `[US3]` map directly to the user stories in spec.md.
- The main guide must keep the official process order intact; do not promote optional validation commands into the mandatory mainline.
- Use specs/20260405-195011-speckit-dev-docs/research.md as the source of truth when command wording or workflow order is in doubt.
