# Implementation Plan: Improve Project Documentation

**Branch**: `20260405-091845-improve-project-docs` | **Date**: 2026-04-05 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/20260405-091845-improve-project-docs/spec.md`

## Summary

Improve AgentSync's documentation surface by turning the README into a concise navigation hub,
adding focused guides for development, architecture, maintenance, command usage, and
troubleshooting, and rolling out concise reasoning-led JSDoc across maintained TypeScript exports
and workflow-significant helpers. The implementation keeps the README compact, uses the existing logo asset
in `docs/agentsync-logo.png`, and shifts detail into purpose-built documents so the repo becomes
easier to evaluate, operate, and maintain without introducing documentation bloat.

## Technical Context

**Language/Version**: TypeScript 6.x (strict mode) plus Markdown documentation  
**Primary Dependencies**: Bun 1.3.9, `citty ^0.2.2`, `@clack/prompts ^1.2.0`, `simple-git ^3.27.0`, `zod ^4.0.0`  
**Storage**: N/A for runtime; repository-hosted Markdown files and source comments only  
**Testing**: `bun test`, `bunx biome ci .`, `bunx tsc --noEmit` via `bun run check`  
**Target Platform**: GitHub-hosted repository plus local CLI usage on macOS/Linux/Windows
**Project Type**: Bun-based CLI daemon with repository documentation  
**Performance Goals**: README routes readers to the right guide within one screenful; users find the correct doc within 2 minutes; docs remain concise while preserving reasoning  
**Constraints**: No verbose prose; all maintained exported TypeScript symbols plus workflow-significant helpers require concise reasoning-led JSDoc; use existing logo in README; no behavioural regressions  
**Scale/Scope**: 53 TypeScript files under `src/`, 109 exported symbols, 41 existing JSDoc blocks, plus new documentation pages under `docs/`

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

### Principle I — Security-First Credential Handling

**Status: PASS** — This feature changes documentation and JSDoc only. The plan explicitly adds
safe-handling guidance for keys, recipients, and vault configuration, and it does not alter any
encryption, sanitization, or sync behaviour.

### Principle II — Test Coverage (NON-NEGOTIABLE)

**Status: PASS** — No new runtime modules are introduced and no behaviour changes are planned.
Comment-only and Markdown-only edits should preserve current coverage. Verification still runs
`bun run check` to catch accidental breakage while editing many source files for JSDoc.

### Principle III — Cross-Platform Daemon Reliability

**Status: PASS** — The plan includes architecture and operational docs that explicitly describe
platform-specific daemon installers and path resolution. No IPC, watcher, or installer logic is
changed.

### Principle IV — Code Quality with Biome

**Status: PASS** — Large-scale JSDoc edits will be constrained to existing files and validated with
Biome plus TypeScript checks. No new linting or formatting tools are introduced.

### Principle V — JSDoc Documentation Standards

**Status: PASS** — This feature directly implements and strengthens Principle V by extending
concise, reasoning-oriented JSDoc coverage across all maintained exported TypeScript symbols and
workflow-significant helpers within project source.

### Post-Design Re-check

All constitution principles remain satisfied after Phase 1 design. The design keeps the
documentation set concise, does not add conflicting tooling, and makes Principle V an explicit
deliverable rather than an implied maintenance guideline.

## Project Structure

### Documentation (this feature)

```text
specs/20260405-091845-improve-project-docs/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── documentation-surface.md
└── tasks.md
```

### Source Code (repository root)

```text
README.md                              ← UPDATE: concise landing page with logo + navigation
docs/
├── agentsync-logo.png                ← EXISTING: logo asset referenced from README
├── architecture.md                   ← NEW: system overview and module boundaries
├── command-reference.md              ← NEW: concise command and workflow reference
├── development.md                    ← NEW: setup, scripts, and contributor workflow
├── maintenance.md                    ← NEW: docs/JSDoc upkeep expectations
└── troubleshooting.md                ← NEW: common failure diagnosis paths

src/
├── cli.ts                            ← UPDATE: top-level JSDoc where missing
├── agents/                           ← UPDATE: add/normalize JSDoc for snapshot/apply flows
├── commands/                         ← UPDATE: add/normalize command and helper JSDoc
├── config/                           ← UPDATE: add/normalize config loader/path/schema JSDoc
├── core/                             ← UPDATE: add/normalize git/encryption/ipc/tar/watcher JSDoc
├── daemon/                           ← UPDATE: add/normalize daemon and installer JSDoc
├── lib/                              ← UPDATE: add/normalize utility JSDoc
└── test-helpers/                     ← UPDATE: add/normalize helper JSDoc where maintained
```

**Structure Decision**: Single-project repository. The implementation adds focused documentation
pages under `docs/`, updates `README.md`, and touches existing `src/` files to close JSDoc gaps.
No new runtime modules, packages, or application subprojects are introduced.

## Complexity Tracking

No constitution violations. No complexity justifications required.

---

## Phase 0 — Research Summary

All research is complete. See [research.md](./research.md) for full findings. Key decisions:

| Topic                                  | Decision                                                                               | Why                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Documentation information architecture | Keep `README.md` short and move detail into focused guides                             | Satisfies the user's anti-verbosity constraint while improving discoverability         |
| JSDoc scope                            | Cover all maintained TypeScript functions and methods in project source                | Meets the clarified requirement and aligns with Constitution Principle V               |
| JSDoc style                            | Use concise reasoning-led blocks, typically 1-3 short lines plus tags only when useful | Prevents boilerplate while preserving intent and non-obvious constraints               |
| README branding                        | Use `docs/agentsync-logo.png` near the top of the README with descriptive alt text     | Reuses the existing repo asset and improves project identity without adding new assets |
| Required guides                        | Add `development.md`, `architecture.md`, and `maintenance.md`                          | Explicit user requirement                                                              |
| Additional high-value guides           | Add `command-reference.md` and `troubleshooting.md`                                    | These reduce README size while covering common contributor and operator needs          |

---

## Phase 1 — Design

### Interface Contracts

See [contracts/documentation-surface.md](./contracts/documentation-surface.md).

This feature exposes a documentation interface rather than a runtime API. The contract defines:

- Required README sections and logo placement
- Required documentation pages and their intended audiences
- JSDoc coverage and style rules for maintained TypeScript source
- Navigation and cross-linking expectations between docs

### Data Model

See [data-model.md](./data-model.md) — the design models documentation artifacts, JSDoc targets,
navigation links, and the logo asset as first-class entities so implementation can verify
coverage and consistency.

### Quickstart

See [quickstart.md](./quickstart.md) for the implementation order and verification workflow.

---

## Phase 2 — Implementation Plan

### Overview

The work should be executed in five phases so the documentation system becomes coherent before the
large-scale JSDoc rollout begins.

```text
Phase A: Audit and define documentation coverage
Phase B: Rewrite README as the navigation hub with logo
Phase C: Add focused documentation pages
Phase D: Roll out concise JSDoc across maintained source files
Phase E: Consistency review and verification
```

### Phase A — Audit and Coverage Map

**Goal**: Establish the exact list of documentation surfaces and source files that must be updated.

**Actions**:

1. Inventory current user-facing workflows from `src/cli.ts`, `src/commands/`, and `src/agents/`.
2. Inventory maintained source files under `src/` and identify exported symbols and significant helpers lacking JSDoc.
3. Map documentation needs into five target pages: README, development, architecture,
   maintenance, command reference, and troubleshooting.
4. Flag any source areas where existing comments are verbose, stale, or inconsistent with the
   new concise standard.

**Output**: File-level coverage list for docs and JSDoc edits.

### Phase B — README Navigation Hub

**Goal**: Turn `README.md` into the single entry point for new readers without letting it become a
long-form manual.

**Required README sections**:

1. Logo display using `docs/agentsync-logo.png`
2. One concise project summary
3. Current implementation status in compact form
4. Quick start for install, init, push, pull, and status/doctor orientation as appropriate
5. Documentation map linking to development, architecture, maintenance, command reference, and troubleshooting

**Design rule**: If a section needs more than a few paragraphs or a compact table, move that detail
to a dedicated `docs/` page and link to it.

### Phase C — Focused Guides

**Goal**: Add purpose-built guides so each audience can find a short, relevant document instead of
mining a single oversized README.

**Files to create**:

1. `docs/development.md`
   Purpose: local setup, scripts, checks, contributor workflow, testing expectations.

2. `docs/architecture.md`
   Purpose: module boundaries, sync flow, security boundaries, daemon/IPC/watcher relationships,
   supported agent integrations.

3. `docs/maintenance.md`
   Purpose: when docs and JSDoc must be updated, review checklist, documentation ownership rules,
   release/change hygiene.

4. `docs/command-reference.md`
   Purpose: concise command-by-command reference for `init`, `push`, `pull`, `status`, `doctor`,
   `daemon`, and `key`.

5. `docs/troubleshooting.md`
   Purpose: common setup, vault, key, remote, and daemon failure cases.

### Phase D — JSDoc Rollout

**Goal**: Bring maintained TypeScript source into compliance with the clarified documentation rule.

**Target areas**:

1. `src/agents/` — snapshot/apply entry points and helper flows
2. `src/commands/` — command handlers and runtime-context helpers
3. `src/config/` — config loading, path resolution, schema-adjacent helpers
4. `src/core/` — git, encryption, IPC, tar, watcher, and sanitization APIs
5. `src/daemon/` — daemon start flow and platform installers
6. `src/lib/` and `src/test-helpers/` — maintained utility functions where present

**JSDoc scope**:

- Exported functions, classes, interfaces, and types are mandatory.
- Maintained internal helpers also receive JSDoc when they carry workflow, safety, or integration meaning.

**JSDoc style contract**:

- Prefer one summary sentence plus one short reasoning or constraint sentence when needed.
- Do not restate obvious names mechanically.
- Use `@param`, `@returns`, and `@throws` only where they add signal.
- Keep each block short enough to scan quickly in-editor.

### Phase E — Consistency Review and Verification

**Goal**: Ensure the documentation system reads as one coherent set rather than a pile of pages.

**Verification steps**:

1. Run `bun run typecheck`
2. Run `bun run lint`
3. Run `bun run test`
4. Manually review README rendering, including the logo and link layout
5. Manually review each new guide for brevity, consistent terminology, and cross-links
6. Spot-check multiple source files to confirm JSDoc is concise and reasoning-led rather than boilerplate
