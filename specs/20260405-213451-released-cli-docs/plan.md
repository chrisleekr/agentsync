# Implementation Plan: Released CLI Documentation Refresh

**Branch**: `20260405-213451-released-cli-docs` | **Date**: 2026-04-05 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/20260405-213451-released-cli-docs/spec.md`

## Summary

Align the repository documentation around the released CLI path so readers can tell how to install AgentSync with `bunx`, how to use the published command surface, and when they should prefer the released path over the contributor-from-source workflow. The implementation is documentation-only and will update every documentation surface that currently routes readers into install, command usage, maintenance expectations, or troubleshooting so the released path is taught consistently.

## Technical Context

**Language/Version**: Markdown documentation plus TypeScript 6.x and Bun 1.3.9 repository context  
**Primary Dependencies**: Existing repo toolchain only; no new runtime or documentation dependencies  
**Storage**: Repository-hosted Markdown files and feature-planning artifacts only  
**Testing**: `bun run check` plus manual documentation walkthrough validation recorded in feature artifacts  
**Target Platform**: GitHub-hosted repository documentation for released CLI users and contributors on macOS, Linux, and Windows
**Project Type**: Bun-based CLI and daemon project with repository documentation  
**Performance Goals**: Readers can identify install path, command path, and release-versus-source decision points within one document hop; reviewers can verify doc consistency across affected pages in under 5 minutes  
**Constraints**: Documentation-only scope; no runtime, packaging, CI, exported symbol, or generated workflow changes; no Mermaid unless prose cannot explain the routing clearly enough  
**Scale/Scope**: Five repository-hosted documentation surfaces plus planning artifacts: `README.md`, `docs/command-reference.md`, `docs/development.md`, `docs/maintenance.md`, and `docs/troubleshooting.md`

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

### Principle I — Security-First Credential Handling

**Status: PASS** — The feature updates wording only. It does not change key handling, vault content, recipient behavior, or secret scanning rules.

### Principle II — Test Coverage (NON-NEGOTIABLE)

**Status: PASS** — This feature qualifies for the documentation-only exception because the planned changes are limited to repository-hosted documentation and feature-planning artifacts. The plan preserves the required `bun run check` merge gate and records manual walkthrough validation steps in [quickstart.md](./quickstart.md).

### Principle III — Cross-Platform Daemon Reliability

**Status: PASS** — No daemon, IPC, watcher, or installer behavior changes are planned. Documentation will clarify command routing only.

### Principle IV — Code Quality with Biome

**Status: PASS** — No code or tooling changes are introduced. Verification still includes the existing repository check command to catch accidental drift.

### Principle V — Documentation Standards

**Status: PASS** — The design keeps the docs concise, treats the GitHub Release record as the canonical release-information surface, and concludes that a Mermaid diagram is not required because the work is wording and routing clarification across existing pages rather than a workflow whose structure is materially clearer as a diagram.

### Post-Design Re-check

All constitution principles remain satisfied after Phase 1 design. The design keeps the feature documentation-only, preserves manual walkthrough validation in feature artifacts, and avoids introducing a diagram where prose remains clearer and lower maintenance.

## Project Structure

### Documentation (this feature)

```text
specs/20260405-213451-released-cli-docs/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── released-cli-documentation-surface.md
└── tasks.md
```

### Source Code (repository root)

```text
README.md                     ← UPDATE: released CLI install, usage, and when-to-use routing
docs/
├── command-reference.md      ← UPDATE: released command examples and support-state wording
├── development.md            ← UPDATE: source workflow boundary and redirect to released docs
├── maintenance.md            ← UPDATE: documentation ownership and release-path consistency rules
└── troubleshooting.md        ← UPDATE: released-versus-source troubleshooting command guidance
```

**Structure Decision**: Single-project repository with documentation-only changes. The implementation is confined to repo-hosted Markdown pages that influence installation, command usage, maintenance, and troubleshooting guidance for the released CLI path.

## Complexity Tracking

No constitution violations. No complexity justifications required.

---

## Phase 0 — Research Summary

All research is complete. See [research.md](./research.md) for full findings. Key decisions:

| Topic                         | Decision                                                                                                                                 | Why                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Entry-point guidance          | Keep `README.md` as the released-user entry point for install, first verification, and release lookup                                    | Readers start there first and need the released path before source details                              |
| Command examples              | Use the published `bunx --package @chrisleekr/agentsync agentsync ...` shape wherever the page is describing a released command contract | Bare `agentsync ...` examples force readers to infer how the published CLI is actually invoked          |
| Release-versus-source routing | Explicitly tell readers when to use released CLI docs versus contributor-from-source docs in every affected page                         | Prevents mixed guidance across README, command reference, development, maintenance, and troubleshooting |
| Canonical release info        | Keep GitHub Releases as the single release-information source for version and change lookup                                              | Existing docs already anchor on this and it avoids duplicate sources of truth                           |
| Diagram need                  | Do not add a Mermaid diagram for this feature                                                                                            | The work is wording alignment across docs, not a complex lifecycle that prose fails to explain          |

---

## Phase 1 — Design

### Interface Contracts

See [contracts/released-cli-documentation-surface.md](./contracts/released-cli-documentation-surface.md).

This feature exposes a documentation contract rather than a runtime API. The contract defines:

- Which pages must teach installation, usage, and when-to-use boundaries for the released CLI path
- Which pages must redirect readers to contributor-from-source guidance instead of duplicating it
- Which release-information source is canonical
- Which troubleshooting pages must use or explicitly contextualize released command examples

### Data Model

See [data-model.md](./data-model.md) — the design models documentation surfaces, reader intents, execution paths, canonical release references, and manual validation steps so implementation can check coverage and consistency.

### Quickstart

See [quickstart.md](./quickstart.md) for the implementation order and manual validation workflow.

---

## Phase 2 — Implementation Plan

### Overview

Execute the documentation refresh in four phases so routing is defined before wording changes are spread across the docs set.

```text
Phase A: Audit released-path wording and contradictions
Phase B: Update entry and command-reference guidance
Phase C: Align contributor, maintenance, and troubleshooting docs
Phase D: Run consistency review and validation
```

### Phase A — Audit Released-Path Coverage

**Goal**: Establish the exact set of pages that currently teach, imply, or contradict the released CLI path.

**Actions**:

1. Review `README.md` for install, verification, and release-record routing.
2. Review `docs/command-reference.md` for command examples that still assume bare `agentsync` execution without clarifying the released invocation path.
3. Review `docs/development.md`, `docs/maintenance.md`, and `docs/troubleshooting.md` for source-only guidance that should either stay source-only with explicit labels or redirect released users elsewhere.
4. Record the wording gaps for installation, how to use, and when to use the released path.

**Output**: File-level wording map covering every affected documentation surface.

### Phase B — Entry And Command Guidance

**Goal**: Make the released path explicit where readers first decide how to install and run the CLI.

**Files to update**:

1. `README.md`
   Purpose: show the install path, first verification command, common `bunx` usage pattern, and when the released path applies.

2. `docs/command-reference.md`
   Purpose: teach released command usage consistently, including the published invocation pattern and support-state wording for published versions.

**Design rule**: If a reader is trying to install or run a released version, these two pages must answer the question without requiring source-based docs first.

### Phase C — Supporting Documentation Alignment

**Goal**: Keep adjacent documentation from contradicting or diluting the released CLI guidance.

**Files to update**:

1. `docs/development.md`
   Purpose: keep source workflow guidance explicit and redirect released users to the correct pages.

2. `docs/maintenance.md`
   Purpose: define which docs must stay aligned whenever the released CLI path changes and preserve the GitHub Releases source-of-truth rule.

3. `docs/troubleshooting.md`
   Purpose: ensure troubleshooting commands either use released-path examples or clearly state that the page assumes contributor-from-source execution.

**Design rule**: Supporting docs should redirect, not duplicate. Any page that remains source-oriented must say so early and point released users back to the released-path docs.

### Phase D — Consistency Review And Validation

**Goal**: Verify that installation, usage, and when-to-use guidance reads as one coherent documentation system.

**Verification steps**:

1. Run `bun run check`.
2. Manually review `README.md` for released install, first verification, and when-to-use wording.
3. Manually review `docs/command-reference.md` to confirm command examples and support-state wording match the released path.
4. Manually review `docs/development.md`, `docs/maintenance.md`, and `docs/troubleshooting.md` to confirm the released-versus-source boundary is explicit and consistent.
5. Confirm every affected page points readers to GitHub Releases for release version and change information.

**Exit criteria**: No affected doc page leaves readers guessing how to install the released CLI, how to invoke it, or when to prefer the released path over the contributor workflow.

<!-- End of implementation plan -->
