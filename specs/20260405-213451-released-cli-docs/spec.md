# Feature Specification: Released CLI Documentation Refresh

**Feature Branch**: `20260405-213451-released-cli-docs`  
**Created**: 2026-04-05  
**Status**: Draft  
**Input**: User description: "Update documentations with released CLI paht"

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Released users find the published command path quickly (Priority: P1)

Readers evaluating the released CLI need the entry documentation to show the published command path, the prerequisites for using it, and where to confirm which release they are reading about.

**Why this priority**: This is the primary reader need. If the entry documentation does not show the released command path clearly, users either assume the product is source-only or must infer the right invocation from scattered docs.

**Independent Test**: Open the entry documentation as a first-time released user and confirm it shows the published command path, a first verification step, and the canonical release-information source without needing any other doc first.

**Acceptance Scenarios**:

1. **Given** a reader opens the entry documentation to use a released version, **When** they scan the released CLI section, **Then** they can identify the published command path and the first verification command without reading source-only instructions.
2. **Given** a reader wants to know which released version they should trust, **When** they follow the release guidance in the docs, **Then** they are directed to the canonical release record for version and change information.

---

### User Story 2 - Supporting docs keep released and source workflows distinct (Priority: P2)

Contributors and operators need the supporting documentation surfaces to separate the released CLI workflow from the contributor-from-source workflow so users do not mix published usage with local development or troubleshooting commands.

**Why this priority**: Once the released path is documented, ambiguity between released and source workflows becomes the main source of reader error.

**Independent Test**: Review the supporting documentation pages that route readers into setup and troubleshooting and confirm each page makes the released-versus-source split explicit.

**Acceptance Scenarios**:

1. **Given** a contributor reads the setup or troubleshooting docs, **When** they compare the released workflow and the contributor-from-source workflow, **Then** the docs describe which one applies in each context.
2. **Given** a reader starts in the wrong guide for their goal, **When** they encounter the scope note for that page, **Then** they are redirected to the appropriate documentation surface.

---

### User Story 3 - Reviewers can validate the change as documentation-only (Priority: P3)

Maintainers need to review the documentation refresh quickly and confirm that it changes repository-hosted documentation only, not product behavior.

**Why this priority**: The documentation-only exception depends on the scope being explicit and reviewable.

**Independent Test**: Review the changed files listed in the spec and verify they are documentation or planning artifacts only, with manual walkthrough validation steps recorded.

**Acceptance Scenarios**:

1. **Given** a reviewer checks the planned scope, **When** they compare it against the spec, **Then** they can confirm that runtime source, packaging, CI, and generated workflow behavior remain unchanged.

### Edge Cases

- The docs must explain what readers should rely on when a released version exists but they still land in contributor-from-source documentation first.
- The docs must not imply that an unpublished or unreleased version is available through the released CLI path.
- The docs must stay consistent even if only one of the affected documentation pages is updated in a partial draft, so reviewers can spot remaining mismatches.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The entry documentation MUST describe the released CLI path in plain language, including what readers need before using it and how to verify they are invoking the published CLI successfully.
- **FR-002**: The documentation set MUST distinguish the released CLI workflow from the contributor-from-source workflow wherever readers choose between those two paths.
- **FR-003**: The command lookup documentation MUST describe the released command path as the supported path for published versions and must not require readers to infer it from source-based examples.
- **FR-004**: The updated documentation MUST direct readers to the canonical release-information surface for release version and change details.
- **FR-005**: The documentation MUST make the support-state boundary explicit when the released CLI path depends on a completed release being available.
- **FR-006**: The feature MUST remain documentation-only, limited to repository-hosted documentation and feature-planning artifacts, with no changes to runtime source files, exported symbols, configuration schemas, packaging behavior, CI automation, or generated workflow scripts.
- **FR-007**: The spec, plan, or quickstart artifacts MUST record manual walkthrough steps that reviewers can use to confirm the released CLI path and source workflow are documented consistently.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A first-time reader can identify the correct starting point for the released CLI workflow within 60 seconds of opening the entry documentation.
- **SC-002**: A reviewer can verify, in under 5 minutes, that the affected documentation surfaces describe the released CLI path and contributor-from-source path without contradiction.
- **SC-003**: All affected documentation surfaces use the same canonical release-information source for version and change lookup.
- **SC-004**: The change can be reviewed and merged as documentation-only without requiring runtime, packaging, or workflow modifications.

## Assumptions

- A released CLI path already exists from earlier release-surface work and only needs clearer documentation coverage.
- The scope of this feature is limited to repository-hosted documentation and feature-planning artifacts.
- No new command behavior, release process, or support-state policy is being introduced beyond clarifying existing guidance.
- Reviewers will validate this feature through documented manual walkthrough steps rather than new automated tests because the change qualifies for the documentation-only exception.

## Documentation Impact

- Expected documentation surfaces include `README.md`, `docs/command-reference.md`, `docs/development.md`, `docs/maintenance.md`, and `docs/troubleshooting.md` to keep released and source workflows aligned.
- This feature qualifies for the documentation-only testing exception because the intended scope is limited to repository-hosted docs and feature-planning artifacts. Runtime source, exported symbols, configuration schemas, packaging logic, CI automation, and generated workflow behavior remain out of scope.
- A Mermaid diagram is not required because the change clarifies routing and wording across existing docs rather than introducing a new workflow structure that prose cannot explain clearly.
- Manual walkthrough validation for reviewers:
  1. Open the entry documentation and confirm it shows the released CLI path, prerequisites, and first verification step.
  2. Open the command lookup documentation and confirm it describes the released command path without forcing source-based commands as the default.
  3. Open `docs/development.md`, `docs/maintenance.md`, and `docs/troubleshooting.md` and confirm they distinguish released usage from contributor-from-source workflow and preserve the canonical release-information source.
