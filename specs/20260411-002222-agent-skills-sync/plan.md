# Implementation Plan: Sync Agents' Skills

**Branch**: `20260411-002222-agent-skills-sync` | **Date**: 2026-04-11 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/20260411-002222-agent-skills-sync/spec.md`

## Summary

Extend AgentSync so that user-created skill directories for Claude, Cursor, and Codex round-trip through the encrypted vault the same way Copilot skills already do, plus harden the existing Copilot pipeline with the same rules. User-created means: top-level entry under `<agent>/skills/` is a **real** directory (not a symlink into a vendored pool), its name does **not** start with `.`, and it contains a **real** (not symlinked) `SKILL.md` sentinel. The feature also introduces a deliberate, per-skill vault-removal action so users can take a single skill out of the vault without deleting their local copy, plus a strict "pull never deletes a local skill" guarantee on the other side.

The technical approach reuses every existing primitive: `tar` for archiving, `age` for encryption, `SnapshotArtifact` for the push pipeline, and the registry-driven agent iteration in `commands/push.ts` and `commands/pull.ts`. The only new cross-cutting piece is a shared skills-walker helper that encodes FR-002 / FR-006 / FR-016 / FR-017 in one place, so Claude, Cursor, Codex, and Copilot all apply identical rules. The new CLI verb is the one surface that is genuinely new: `agentsync skill remove <agent> <name>`, with a non-zero "not found" exit path.

## Technical Context

**Language/Version**: TypeScript 6.x, strict mode (`"strict": true`), Bun ≥ 1.3.9 runtime
**Primary Dependencies**: `citty` (CLI), `@clack/prompts` (output), `tar` v7 (archive), `age-encryption` (X25519 encryption), `simple-git` (vault Git ops), `zod` (schema validation), `picocolors` (terminal colours)
**Storage**: Local filesystem only. Skill sources at `~/.claude/skills/`, `~/.cursor/skills/`, `~/.codex/skills/`, `~/.copilot/skills/`. Encrypted destinations at `<vaultDir>/<agent>/skills/<name>.tar.age`, wired through `AgentPaths` in `src/config/paths.ts`
**Testing**: `bun test`. New tests live in `src/agents/__tests__/`, `src/core/__tests__/`, and `src/commands/__tests__/` following the existing `*.test.ts` convention next to the code under test
**Target Platform**: macOS, Linux, Windows (inherits AgentSync's cross-platform constraints; skill walker uses `lstat` which is supported on all three)
**Project Type**: single-project CLI + background daemon (Bun)
**Performance Goals**: No new targets. Skills are tar'd synchronously inside the existing push pipeline. A skills root with ≤ 100 real skills of ≤ 10 MB each should complete the walk and archive phase in well under the existing push timeout. No streaming or chunking changes are in scope
**Constraints**: Must inherit AgentSync's existing security guarantees unchanged — nothing in this feature bypasses `NEVER_SYNC_PATTERNS`, nothing writes plaintext to disk outside atomic writes, and nothing follows symlinks into vendored pools. Partial-archive behavior for real skills containing symlink helpers is a documented, explicit tradeoff (spec edge case)
**Scale/Scope**: Four agents (Claude, Cursor, Codex, Copilot — Copilot is a retrofit), one new CLI verb (`skill remove`), one shared walker helper, ~10–15 new tests, four doc updates (`command-reference.md`, `architecture.md`, `troubleshooting.md`, `README.md`) including two new Mermaid diagrams

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Verdict | Notes |
| --------- | ---- | ------- | ----- |
| I. Security-First Credential Handling | Every new code path MUST encrypt before leaving the machine; never-sync patterns MUST block before encryption; no new recipient types | **Pass** | FR-006 explicitly requires never-sync to run before the tar is encrypted. The walker will pre-scan interior files against `shouldNeverSync` and emit a warning the existing push gate (`push.ts:80-98`) catches and escalates to a fatal error, matching how `"Redacted literal secret"` warnings are handled today. No new recipients, no new keys, no new crypto library |
| II. Test Coverage (NON-NEGOTIABLE) | Runtime-source feature — automated tests required for success + ≥1 error path; ≥70% coverage on new modules; security-critical files stay ≥90% | **Pass** | Test plan (Phase 1 quickstart) enumerates 11 test targets covering: happy-path round-trip per agent (success), symlinked-root skip, dot-entry skip, interior symlink omission, SKILL.md-is-symlink sentinel rejection, never-sync inside skill abort (security error path), explicit vault removal success, vault removal not-found error path. The walker helper is a new module requiring its own unit tests. `sanitizer.ts` and `encryptor.ts` are unchanged, so their ≥90% floor is unaffected |
| III. Cross-Platform Daemon Reliability | No new daemon code unless justified; any new path lookup MUST go through `src/config/paths.ts` | **Pass** | No daemon changes. Three new entries (`claude.skillsDir`, `cursor.skillsDir`, `codex.skillsDir`) are added to `AgentPaths` in `src/config/paths.ts`. `lstat` behavior on Windows: symlinks are represented as reparse points and `lstat` correctly identifies them via `isSymbolicLink()` on Bun / Node's Windows port, so the rule is platform-consistent |
| IV. Code Quality with Biome | `bunx biome ci .` passes with zero errors; no `any`; Zod at trust boundaries | **Pass** | New files typed end-to-end. No new trust boundaries cross this feature (the skill walker consumes local filesystem paths, which are not Zod-validated anywhere else in the codebase today). `useConst` and `noUnusedVariables` enforced. No new imports that Biome can't organise |
| V. Documentation Standards | JSDoc on all new exported symbols; Mermaid diagram where a workflow is materially clearer visually; docs land in the same commit as code | **Pass** | All new exports from the walker helper and the `skill remove` command will have `@param`, `@returns`, `@throws` JSDoc. FR-015 requires two Mermaid diagrams in `docs/architecture.md`: (1) the sync flow for the extended skills path, (2) the vault-removal flow. Both will follow the project's GitHub-compatible Mermaid rules (inline `:::className`, single `subgraph`, `<br/>` for line breaks, no parentheses in node labels, WCAG-AA class definitions) |

**Documentation-only exemption**: **Not applicable**. This feature adds runtime source, CLI surface, and changes observable behavior for `push`, `pull`, and a new `skill remove` verb. The automated-test requirement is fully in force.

**Diagram validation impact**: Two Mermaid diagrams land in `docs/architecture.md`. Both will be validated by the standard `bun run check` plus the project's existing Mermaid review process before merge.

**Net verdict**: All gates pass. **No entries in the Complexity Tracking table.**

## Project Structure

### Documentation (this feature)

```text
specs/20260411-002222-agent-skills-sync/
├── plan.md                      # This file
├── research.md                  # Phase 0 output — decisions on walker shape, tar filter, CLI verb placement, never-sync composition
├── data-model.md                # Phase 1 output — Skill, SkillArtifact, SkillsWalkerResult, RemovalOutcome
├── quickstart.md                # Phase 1 output — manual cross-machine walkthrough the spec requires
├── contracts/
│   ├── vault-paths.md           # Per-agent vault namespace layout + file naming
│   ├── skill-remove-cli.md      # CLI signature, exit codes, output format for `agentsync skill remove`
│   └── walker-interface.md      # Input + output shape of the shared skills walker
└── checklists/
    └── requirements.md          # Already present — quality checklist from /speckit.specify
```

### Source Code (repository root)

```text
src/
├── agents/
│   ├── _utils.ts                # EXTEND: export SkillsWalkerResult type and helper (or add new skills-walker.ts — see research.md)
│   ├── claude.ts                # EXTEND: snapshotClaude now also walks AgentPaths.claude.skillsDir; export applyClaudeSkill; extend applyClaudeVault to decrypt claude/skills/*.tar.age
│   ├── cursor.ts                # EXTEND: snapshotCursor now walks AgentPaths.cursor.skillsDir (the canonical path locked by FR-010); mirror applyCursorSkill + applyCursorVault extension
│   ├── codex.ts                 # EXTEND: snapshotCodex walks AgentPaths.codex.skillsDir; applyCodexSkill + applyCodexVault extension
│   ├── copilot.ts               # RETROFIT: existing skill walker switched to the shared helper so it inherits FR-016 (symlink) and FR-017 (dot-skip) rules
│   ├── registry.ts              # No change — registry iterates existing AgentDefinition entries; new skill logic lives inside each agent's snapshot/apply
│   └── __tests__/
│       ├── claude.test.ts       # EXTEND: skill snapshot + apply tests; symlink/dot-skip/interior-symlink/SKILL.md-symlink edge cases; never-sync inside skill error path
│       ├── cursor.test.ts       # EXTEND: same surface; include the "skills-cursor is never touched" assertion from US3 scenario 3
│       ├── codex.test.ts        # EXTEND: same surface; include a `.system/` top-level dot-skip assertion
│       └── copilot.test.ts      # EXTEND: regression tests for the retrofit — symlink and dot-skip behavior after the walker swap
├── commands/
│   ├── push.ts                  # EXTEND: Phase-1 gate now also catches walker-emitted "never-sync inside skill" warnings and escalates to fatal, mirroring the existing secret-literal path (push.ts:80-98)
│   ├── pull.ts                  # No code change — already iterates agent.apply(); new skill restores come "for free" via the extended applyXxxVault functions
│   ├── status.ts                # No code change — already iterates snapshot artifacts + collects vault .age files recursively (status.ts:22-42 and status.ts:136-154), so new tar.age entries surface automatically
│   ├── doctor.ts                # EXTEND: add readability checks for each new skillsDir
│   ├── skill.ts                 # NEW: citty subcommand group exposing `skill remove` (and room for future verbs)
│   └── __tests__/
│       ├── skill.test.ts        # NEW: success path, not-found error path, leave-local-alone assertion
│       ├── push.test.ts         # EXTEND or ADD: never-sync inside skill aborts with fatal and writes zero .age files
│       └── integration.test.ts  # EXTEND: cross-machine skills round-trip (tmp vault + two mock homes)
├── config/
│   ├── paths.ts                 # EXTEND: add skillsDir to claude, cursor, codex entries
│   └── __tests__/
│       └── paths.test.ts        # EXTEND: assertion for the three new entries on mac / linux branches
├── core/
│   ├── tar.ts                   # EXTEND: archiveDirectory gains an opt-in `skipSymlinks` flag that installs a sync `filter` rejecting symlink entries (using lstatSync on the entry path)
│   ├── sanitizer.ts             # No change to NEVER_SYNC_PATTERNS or exports (the walker composes shouldNeverSync at the interior-walk step)
│   └── __tests__/
│       └── tar.test.ts          # EXTEND: symlink-skip filter behavior; real file preservation inside a symlinked-root walk
└── cli.ts                       # EXTEND: register the new `skill` subcommand group on the root citty command

docs/
├── architecture.md              # EXTEND: module map entry for the skills walker; two new Mermaid diagrams (sync flow + vault-removal flow)
├── command-reference.md         # EXTEND: push/pull/status/doctor entries mention the new skill coverage; new section documenting `skill remove`
├── troubleshooting.md           # EXTEND: 6 new entries as enumerated in the spec's Documentation Impact section
└── README.md                    # EXTEND: "What a vault means here" block names claude/cursor/codex/copilot skills namespaces; new one-line safety note about removal being explicit
```

**Structure Decision**: Single-project layout. The feature fits cleanly into the existing `src/agents/`, `src/commands/`, `src/config/`, `src/core/` split. No new top-level directory is needed. The shared skills walker can live either as an additional export from `src/agents/_utils.ts` (same layer as `SnapshotArtifact`) or as its own `src/core/skills-walker.ts` module — Phase 0 research resolves which.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations. This table is intentionally left empty.
