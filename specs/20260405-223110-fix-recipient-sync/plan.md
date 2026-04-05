# Implementation Plan: Existing Vault Bootstrap Recovery

**Branch**: `20260405-223110-fix-recipient-sync` | **Date**: 2026-04-05 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/20260405-223110-fix-recipient-sync/spec.md`

## Summary

Fix second-machine bootstrap against an existing remote vault by making `init` remote-aware,
standardizing vault updates on an explicit fast-forward-only reconciliation rule, and ensuring
all sync flows fail clearly instead of reporting success after Git divergence errors. The
implementation should centralize Git policy in `src/core/git.ts`, update all command paths that
pull remote state, add regression tests for the reproduced non-fast-forward and divergent-branch
cases, and document the recovery workflow with a validated Mermaid diagram.

## Technical Context

**Language/Version**: TypeScript 6.0.0, strict mode  
**Primary Dependencies**: Bun 1.3.9, `simple-git ^3.27.0`, `citty ^0.2.2`, `@clack/prompts ^1.2.0`, `age-encryption ^0.3.0`, `zod ^4.0.0`  
**Storage**: Local filesystem plus a Git-backed encrypted vault repository  
**Testing**: `bun test` via repo command `bun run check`; integration and unit tests under `__tests__/`  
**Target Platform**: macOS, Linux, and Windows for CLI and daemon workflows  
**Project Type**: CLI plus background daemon  
**Performance Goals**: Second-machine bootstrap should complete in a single command path when the remote vault already exists; divergence failures should surface before any unnecessary agent apply work  
**Constraints**: Must not depend on user-specific Git config; must preserve recipient and private-key safety; must avoid false-success command output; must keep daemon and CLI behavior aligned  
**Scale/Scope**: Single repository; affects `init`, `pull`, `push`, `key`, daemon sync entry points, shared Git abstraction, tests, and troubleshooting/docs

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

### Principle I — Security-First Credential Handling

**Status: PASS** — The feature changes Git bootstrap and reconciliation behavior, not encryption
algorithms or secret-handling rules. Recipient configuration remains explicit in `agentsync.toml`.
The design must preserve the rule that private keys never leave the local machine and that vault
content is only written after the repository state is safe to update.

### Principle II — Test Coverage (NON-NEGOTIABLE)

**Status: PASS** — This is runtime behavior work, so automated tests are mandatory. The plan
includes success and error-path coverage for existing-vault bootstrap, fast-forward update, and
divergence failure messaging. Validation will run through `bun run check`.

### Principle III — Cross-Platform Daemon Reliability

**Status: PASS** — The daemon already delegates to shared `performPull()` and `performPush()`.
Centralizing Git reconciliation inside `src/core/git.ts` preserves cross-platform behavior rather
than introducing platform-specific sync logic.

### Principle IV — Code Quality with Biome

**Status: PASS** — No new tooling is required. Runtime data that crosses trust boundaries remains
validated with existing schemas. The implementation is confined to existing TypeScript modules and
tests.

### Principle V — Documentation Standards

**Status: PASS** — The feature changes observable command behavior and troubleshooting guidance, so
docs must update in the same change. A Mermaid diagram is required because the bootstrap and
reconciliation flow has multiple decision points that are materially clearer visually than in prose.

### Post-Design Re-check

All constitution gates remain satisfied after Phase 1 design. No violations require complexity
tracking or constitutional exceptions.

## Project Structure

### Documentation (this feature)

```text
specs/20260405-223110-fix-recipient-sync/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── vault-sync-workflow.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── commands/
│   ├── init.ts
│   ├── pull.ts
│   ├── push.ts
│   ├── key.ts
│   └── __tests__/
│       └── integration.test.ts
├── core/
│   ├── git.ts
│   └── __tests__/
│       └── git.test.ts
└── daemon/
    └── index.ts

docs/
├── architecture.md
├── command-reference.md
└── troubleshooting.md
```

**Structure Decision**: Single-project CLI/daemon repository. The implementation should extend the
existing Git abstraction and command modules rather than adding a new subsystem.

## Complexity Tracking

No constitution violations. No complexity justifications required.

---

## Phase 0 — Research Summary

All Phase 0 research is complete. See [research.md](./research.md) for full findings.

| Topic                               | Decision                                                                                   | Why                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Existing remote vault during `init` | Detect remote branch state before creating local history; join existing remote state first | Prevents local-only init commits that guarantee non-fast-forward push rejection |
| Vault reconciliation rule           | Use explicit fast-forward-only behavior for remote updates                                 | Makes behavior deterministic and independent of user Git config                 |
| Divergence failure handling         | Treat reconciliation failures as hard failures, not warning-plus-success flows             | Prevents misleading `Pull completed: 0 agent(s) synced.` outcomes               |
| Shared implementation point         | Centralize the policy in `src/core/git.ts` and reuse from all command paths                | Avoids drift across `init`, `pull`, `push`, `key`, and daemon sync              |

---

## Phase 1 — Design

### Interface Contracts

This feature changes observable CLI and daemon behavior, so one contract document is required:

- [contracts/vault-sync-workflow.md](./contracts/vault-sync-workflow.md)

The contract will define:

- existing-vault bootstrap behavior for `init`
- fast-forward update behavior for `pull`, `push`, `key add`, and `key rotate`
- divergence failure outcomes and user-visible messaging
- daemon reuse of the same reconciliation policy

### Data Model

See [data-model.md](./data-model.md).

Core entities:

- Remote Vault State
- Local Vault State
- Reconciliation Policy
- Reconciliation Result
- Command Outcome

### Quickstart

See [quickstart.md](./quickstart.md).

The quickstart will capture:

- how to reproduce the second-laptop failure against an existing remote
- expected behavior after the fix
- manual reviewer validation steps
- a Mermaid workflow diagram for bootstrap and reconciliation

---

## Phase 2 — Implementation Plan

### Overview

The implementation should land in five ordered phases so command behavior, tests, and docs stay
aligned.

```text
Phase A: Extend the Git abstraction with explicit reconciliation helpers
Phase B: Rework existing-vault bootstrap in init
Phase C: Apply shared reconciliation and failure semantics across sync flows
Phase D: Add regression tests for bootstrap, divergence, and messaging
Phase E: Update docs and validate Mermaid plus repository checks
```

### Phase A — Extend Shared Git Behavior

**Goal**: Make repository-state decisions explicit and reusable.

**Target files**:

- `src/core/git.ts`
- `src/core/__tests__/git.test.ts`

**Design tasks**:

1. Add shared helpers to inspect remote branch state and perform fast-forward-only updates or
   return typed errors that command code can translate into user-facing messages.
2. Preserve existing push and branch helpers while making reconciliation independent of global
   Git configuration.
3. Add unit tests that cover:
   - remote branch absent
   - remote branch present and fast-forwardable
   - local and remote divergence producing a controlled error

### Phase B — Rework `init` for Existing Remote Vaults

**Goal**: Prevent second-machine bootstrap from inventing local history before remote state is known.

**Target files**:

- `src/commands/init.ts`
- `src/commands/__tests__/integration.test.ts`

**Design tasks**:

1. Split `init` into two explicit paths:
   - empty remote bootstrap
   - existing remote join
2. For the existing remote path, align local repository state to the remote branch first, then
   merge in machine-specific config updates such as the new recipient and runtime settings.
3. Ensure `init` reports partial or failed bootstrap clearly and does not print a fully successful
   outcome if the remote join did not complete.
4. Update the user-facing bootstrap documentation in the same change as the `init` behavior so the
   command reference, troubleshooting guidance, and entry-point setup flow reflect the new semantics.

### Phase C — Apply Shared Reconciliation to All Sync Flows

**Goal**: Eliminate command-by-command drift in Git update behavior.

**Target files**:

- `src/commands/pull.ts`
- `src/commands/push.ts`
- `src/commands/key.ts`
- `src/daemon/index.ts`

**Design tasks**:

1. Replace bare pull calls with the shared reconciliation helper.
2. Preserve the narrow first-time-safe exceptions where a missing remote branch is acceptable.
3. Convert reconciliation failures into hard command failures that suppress false success messages.
4. Keep daemon-triggered pull/push behavior aligned with the CLI wrappers.
5. Update divergence and reconciliation documentation in the same change as the runtime behavior,
   including the architecture flow and command/troubleshooting guidance.

### Phase D — Regression and Messaging Tests

**Goal**: Lock the fix into the repository with both success and error-path coverage.

**Target files**:

- `src/core/__tests__/git.test.ts`
- `src/commands/__tests__/integration.test.ts`

**Required coverage**:

1. `init` against an empty remote still succeeds.
2. `init` against an already-populated remote joins existing history without non-fast-forward push.
3. `pull` on a divergent local branch returns a controlled error and no success-style output.
4. At least one other reconciliation consumer such as `push` or `key add` inherits the same policy.

### Phase E — Documentation, Diagram, and Verification

**Goal**: Validate the already-updated documentation, diagrams, and reviewer workflow after the
paired runtime-and-doc changes from earlier phases land.

**Target files**:

- `README.md`
- `docs/command-reference.md`
- `docs/troubleshooting.md`
- `docs/architecture.md`
- `specs/20260405-223110-fix-recipient-sync/quickstart.md`
- `specs/20260405-223110-fix-recipient-sync/contracts/vault-sync-workflow.md`

**Design tasks**:

1. Verify the user-facing and architecture documentation updated in earlier phases matches the final runtime behavior.
2. Validate the Mermaid workflow explanations before merge.
3. Execute the reviewer walkthrough and contract-compliance checks against the implemented behavior.
4. Run `bun run check` as the final verification gate.
