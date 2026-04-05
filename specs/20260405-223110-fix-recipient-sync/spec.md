# Feature Specification: Existing Vault Bootstrap Recovery

**Feature Branch**: `20260405-223110-fix-recipient-sync`  
**Created**: 2026-04-05  
**Status**: In Validation  
**Input**: User description: "Recipient sync process issue"

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Users can initialize a second laptop against an existing vault (Priority: P1)

People setting up AgentSync on another laptop need `init` to connect that machine to an existing remote vault without creating a divergent local history that later blocks `pull` and `push`.

**Why this priority**: The first failure happens during setup. If `init` creates a local-only commit instead of joining the existing remote history, the machine enters a broken state immediately and later commands become misleading.

**Independent Test**: Start with a remote vault that already has history, run `init` on a fresh second machine, and confirm the machine joins the existing vault state without producing a non-fast-forward rejection.

**Acceptance Scenarios**:

1. **Given** a remote vault already contains commits from another machine, **When** a user runs `init` on a fresh laptop, **Then** the local vault is aligned with the remote history before any new machine-specific changes are committed.
2. **Given** `init` cannot safely join the existing remote state, **When** the command stops, **Then** it reports the bootstrap problem clearly and does not leave the user believing setup succeeded fully.

---

### User Story 2 - Users can recover from divergent local and remote vault history (Priority: P2)

People who already reached a divergent state need `pull` and related sync flows to either reconcile safely using the product's chosen strategy or explain the required manual recovery step without hiding the failure behind a partial-success message.

**Why this priority**: The current follow-on failure is worse than the initial one because `pull` reports an error about divergent branches but still prints a successful-looking completion message with zero synced agents.

**Independent Test**: Reproduce a local/remote divergence, run the recovery path, and confirm the command either restores a healthy branch state or exits with an unambiguous error and no false success output.

**Acceptance Scenarios**:

1. **Given** local vault history diverges from the remote branch, **When** a user runs `pull`, **Then** the command uses an explicit, product-defined reconciliation strategy or exits with a recovery instruction instead of surfacing raw Git ambiguity.
2. **Given** reconciliation cannot be completed automatically, **When** the command finishes, **Then** it does not report a successful sync outcome.

---

### User Story 3 - Maintainers can validate Git reconciliation behavior consistently (Priority: P3)

Maintainers and reviewers need bootstrap, pull, push, key management, daemon sync, and troubleshooting surfaces to use the same Git reconciliation model so second-machine setup failures are predictable and testable.

**Why this priority**: The bare `git pull` pattern appears in multiple command paths. Fixing only one entry point would recreate the same class of failure elsewhere.

**Independent Test**: Review the command flows and docs that touch remote synchronization and confirm they use the same divergence strategy, same error language, and same reviewer walkthrough.

**Acceptance Scenarios**:

1. **Given** a maintainer reviews `init`, `pull`, `push`, `key`, and daemon sync behavior, **When** they compare the Git reconciliation paths, **Then** those paths follow one explicit product rule for existing remote history and branch divergence.
2. **Given** a reviewer needs to understand second-machine bootstrap behavior, **When** they open the planning or documentation artifacts, **Then** they can follow a single workflow diagram or walkthrough without inferring missing Git decisions.

### Edge Cases

- The system must distinguish an empty remote vault from an existing remote branch with history so `init` does not treat both cases as the same bootstrap path.
- The system must handle the case where the local repository has no upstream yet but the remote branch already exists.
- The system must not print a successful-looking completion message after a reconciliation failure that prevented any real sync work.
- The system must keep daemon-driven sync behavior aligned with manual sync behavior for the same Git divergence conditions.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST detect whether the configured remote branch is empty, already populated, or divergent before deciding how to bootstrap or update the local vault.
- **FR-002**: The `init` workflow MUST join an existing remote vault history safely instead of creating a local-first commit path that predictably leads to a non-fast-forward rejection.
- **FR-003**: Sync workflows that update from the remote branch MUST use an explicit product-defined Git reconciliation strategy rather than relying on the user's global Git pull configuration.
- **FR-004**: When the local and remote vault histories cannot be reconciled automatically, the system MUST stop with a user-understandable recovery message that identifies the blocker category, names the blocked sync action, and explains the next required recovery action.
- **FR-005**: The system MUST not emit a success-style completion message for `init`, `pull`, or other sync flows when Git reconciliation failed before the intended outcome was achieved.
- **FR-006**: The chosen reconciliation behavior MUST be applied consistently across `init`, `pull`, `push`, key-management flows that sync with the remote, and daemon-triggered sync operations.
- **FR-007**: The system MUST preserve existing recipient, key, and encrypted-vault safety guarantees while fixing Git bootstrap and divergence handling.
- **FR-008**: Supporting documentation and reviewer artifacts MUST describe the existing-vault bootstrap and divergence recovery workflow in the same terms used by the product.
- **FR-009**: The feature MUST include a Mermaid diagram in the relevant planning or documentation artifacts when that diagram is needed to explain the bootstrap and reconciliation workflow clearly.

### Key Entities _(include if feature involves data)_

- **Remote Vault State**: The observable state of the configured remote branch, including whether it is empty, already initialized, or ahead of the local machine.
- **Local Vault State**: The local repository state created in the runtime vault directory, including branch history, upstream tracking, and pending machine-specific changes.
- **Reconciliation Outcome**: The result of comparing local and remote vault history, such as safe bootstrap, fast-forward update, divergence requiring recovery, or failure.
- **Bootstrap Recovery Action**: The corrective step a user must take when a second machine cannot automatically join the existing vault state.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: On a fresh second machine pointed at an existing remote vault, `init` completes without a non-fast-forward rejection and leaves the local vault aligned to the remote branch on the first attempt.
- **SC-002**: When local and remote vault history are irreconcilable automatically, users can identify the blocker category, the blocked sync action, and the required recovery action within 60 seconds of seeing the error.
- **SC-003**: Reviewer walkthroughs of `init`, `pull`, daemon sync, and troubleshooting guidance show the same reconciliation model and no contradictory success or failure messaging.
- **SC-004**: Git reconciliation failures do not result in successful-looking runs that leave the vault partially bootstrapped, divergent, or incorrectly reported as synced.

## Assumptions

- The reported issue comes from connecting another laptop to an already-initialized remote vault rather than from a brand-new empty remote.
- The current encryption, recipient, and vault model remain in scope; this feature fixes Git bootstrap and reconciliation behavior without changing the security model.
- Users are operating through the supported local CLI and daemon workflow, not through a hosted control plane or external admin surface.
- Reviewers will validate the feature with automated tests for command behavior plus manual walkthrough checks for the documented bootstrap flow.

## Documentation Impact

- Expected documentation surfaces include `README.md`, `docs/command-reference.md`, `docs/troubleshooting.md`, and `docs/architecture.md` so existing-vault bootstrap and divergence handling are described consistently.
- A Mermaid diagram is required because second-machine bootstrap and reconciliation involve multiple decision points that are materially clearer visually than in prose alone.
- Reviewer walkthrough steps must confirm: `init` joins an existing remote safely, reconciliation failures do not emit false success messages, divergence errors state the blocker category, blocked sync action, and recovery action explicitly, daemon and manual sync stay aligned, and the published troubleshooting guidance matches the product behavior.
