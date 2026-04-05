# Feature Specification: Release Project for Bunx Installation

**Feature Branch**: `20260405-112827-bunx-release`  
**Created**: 2026-04-05  
**Status**: Draft  
**Input**: User description: "I want to release project and allow to install using bunx"

## Clarifications

### Session 2026-04-05

- Q: Are you updating any relevant documentations too? → A: Update `README.md`, `docs/development.md`, `docs/command-reference.md`, and `docs/maintenance.md`.
- Q: Are you following security best practice? → A: Require GitHub OIDC trusted publishing only; do not allow long-lived npm tokens.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Install Without Cloning The Repository (Priority: P1)

A user discovers AgentSync and wants to try the CLI immediately. They can install and run the released CLI through a documented `bunx` command without cloning the repository, building from source, or manually wiring the executable.

**Why this priority**: The primary value of this feature is reducing friction between discovering the project and using it. If installation still requires a local clone or contributor workflow, the release surface does not solve the user problem.

**Independent Test**: Can be fully tested by using a clean machine or shell session with Bun available, running the documented `bunx` command, and confirming the CLI starts successfully without a repository checkout.

**Acceptance Scenarios**:

1. **Given** a user has Bun installed but has not cloned the repository, **When** they run the documented `bunx` command for AgentSync, **Then** the CLI is resolved from the released package and starts successfully.
2. **Given** a user has just installed the CLI through `bunx`, **When** they run a basic verification command such as help or version output, **Then** they can confirm that the installation succeeded.
3. **Given** a user wants the current stable release, **When** they use the documented install path, **Then** they receive the latest public release rather than an unreleased source snapshot.

---

### User Story 2 - Publish A Release Users Can Actually Consume (Priority: P1)

A maintainer prepares a new AgentSync release and can publish a version that is not only announced but also immediately consumable by users through the documented `bunx` installation path.

**Why this priority**: A release record without an installable artifact is operationally misleading. The project must treat public release and public consumption as one user-facing workflow.

**Independent Test**: Can be fully tested by completing the release workflow for a new version and verifying that the newly announced version is available through the documented `bunx` command and reports the expected version.

**Acceptance Scenarios**:

1. **Given** a maintainer publishes a new project release, **When** the release is marked available to users, **Then** the corresponding CLI package can be installed and executed through `bunx`.
2. **Given** a new version has been released, **When** a user runs the CLI after installation, **Then** the reported version matches the version announced in the release record.
3. **Given** a release cannot be installed or executed through the supported install path, **When** the release workflow detects that state, **Then** the project does not present that release as ready for user adoption without clear remediation.

---

### User Story 3 - Understand The Released Usage Path Quickly (Priority: P2)

A user or evaluator visits the repository and can immediately tell the difference between contributor setup and released-product usage. They can find the `bunx` install path, prerequisites, a first-run verification step, and what command name to use.

**Why this priority**: Publishing an installable release is insufficient if the primary documentation still routes all users through source-based contributor setup.

**Independent Test**: Can be fully tested by asking someone unfamiliar with the project to open the repository, identify how to install the released CLI via `bunx`, and reach a successful first command without reading source files.

**Acceptance Scenarios**:

1. **Given** a user lands on the project entry documentation, **When** they look for how to use the released CLI, **Then** they can find the `bunx` install path and prerequisites within one reading session.
2. **Given** the project still supports contributor workflows from source, **When** a user reads the documentation, **Then** they can distinguish source-based development steps from the released-user install path.
3. **Given** a user wants to confirm what executable name to run, **When** they follow the release documentation, **Then** the command name and first verification step are unambiguous.

### Edge Cases

- What happens when a user tries the documented `bunx` command before the project has a publicly consumable release? The documentation and release surface must not imply that the installation path is available until it actually works.
- What happens when the release metadata exists but the executable entry point is missing or broken? The release must not be treated as ready for users until the install and invocation path succeeds.
- What happens when documentation still prioritizes cloning the repository and running from source? Users evaluating the released product may follow the wrong workflow, so the public usage path must be clearly separated from contributor setup.
- What happens when a newly released version is available but reports a different version than the release announcement? Users and maintainers must be able to detect that mismatch immediately.
- What happens when a user is on an unsupported platform or does not have Bun installed? The documentation must call out prerequisites and supported environments before the install step.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The project MUST provide a publicly consumable release path for AgentSync that users can invoke through `bunx` without cloning the repository.
- **FR-002**: The released distribution MUST expose the AgentSync CLI under a documented command name that users can run immediately after installation.
- **FR-003**: The project MUST provide a documented verification step that allows users to confirm a successful `bunx`-based installation on first run.
- **FR-004**: Each public release MUST make the corresponding AgentSync version available through the documented `bunx` install path at the time the release is announced to users.
- **FR-005**: The project MUST keep the user-visible version consistent across the release record, the installable distribution, and the CLI output.
- **FR-006**: The release workflow MUST prevent or clearly flag releases that cannot be installed or executed through the supported `bunx` path.
- **FR-007**: `README.md` MUST present the released-user installation path separately from contributor setup from source.
- **FR-008**: `docs/development.md` MUST document the contributor toolchain expectations for Bun runtime use and Node-based publish tooling.
- **FR-009**: `docs/command-reference.md` MUST document the released CLI install path, prerequisites, supported environments, first-run verification step, and command usage for supported users.
- **FR-010**: The project MUST surface release information that helps users identify what version they are installing and what changed in that release.
- **FR-011**: The public release surface MUST include package metadata that allows users to identify the project, executable command, and license before installation.
- **FR-012**: The project MUST not describe `bunx` installation as supported in user-facing documentation until a user can complete that workflow successfully on a supported environment.
- **FR-013**: `docs/maintenance.md` MUST describe the maintainer-facing release and npm publish workflow updates required to keep the documented install path accurate over time.
- **FR-014**: The npm publish workflow MUST use GitHub OIDC trusted publishing and MUST NOT depend on long-lived npm write tokens or equivalent stored publish credentials.

### Key Entities _(include if feature involves data)_

- **Public Release**: A versioned project announcement intended for user adoption, including the release record and the installable CLI distribution.
- **Install Command**: The documented `bunx` invocation a user runs to obtain and start AgentSync without cloning the repository.
- **Installable Distribution**: The published CLI package and metadata that Bun resolves when a user invokes the install command.
- **Release Version**: The user-visible version identifier that must remain consistent across the release record, distribution metadata, and CLI output.
- **First-Run Verification Step**: A simple post-install action, such as help or version output, that confirms the released CLI is usable.
- **Contributor Setup Path**: The source-based workflow used by maintainers and contributors, which must remain distinct from the released-user installation path.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: At least 90% of first-time evaluators can install AgentSync through the documented `bunx` path and reach a successful first-run verification step within 5 minutes without cloning the repository.
- **SC-002**: 100% of public releases during acceptance testing are installable and executable through the documented `bunx` command at the time they are announced.
- **SC-003**: 100% of tested releases report the same version in the release record, installable distribution, and CLI version output.
- **SC-004**: At least 90% of users reviewing the project entry documentation can identify the released install path, prerequisites, and CLI command name on their first attempt.
- **SC-005**: Release validation finds zero cases where user-facing documentation advertises `bunx` installation before the supported workflow is actually available.

## Assumptions

- Bun remains a required prerequisite for the released installation path; this feature does not require additional package-manager install flows.
- The existing CLI command name remains `agentsync` unless implementation finds a release-blocking conflict.
- The feature scope includes public release readiness, installability through `bunx`, and documentation updates for that usage path, but not broader product behavior changes.
- Existing supported operating systems remain the supported environments for the released CLI unless release validation proves otherwise.
- The project will continue to use versioned public release records as part of the user-facing release surface.
