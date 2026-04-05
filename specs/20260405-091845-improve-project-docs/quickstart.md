# Quickstart: Improve Project Documentation

**Branch**: `20260405-091845-improve-project-docs` | **Date**: 2026-04-05

This guide describes the intended implementation order for the documentation feature so the work
stays coherent and the README never becomes a dumping ground for detail.

---

## Prerequisites

```sh
git checkout 20260405-091845-improve-project-docs
bun install
```

---

## Step 1 — Audit The Documentation Surface

1. Review `README.md`, `docs/agentsync-logo.png`, `src/cli.ts`, and the directories under `src/`.
2. List all user-facing workflows that need documentation coverage.
3. Identify functions and methods missing concise JSDoc.

Expected result: a file-level checklist for README, new guides, and JSDoc edits.

---

## Step 2 — Rewrite `README.md` As The Entry Point

1. Add the logo near the top of the README.
2. Replace long explanations with a concise overview and quick start.
3. Add a documentation map that links to the focused guides.

Expected result: a short README that answers "what is this?" and "where do I go next?"
without containing every detail itself.

---

## Step 3 — Add Focused Guides Under `docs/`

Create and populate:

1. `docs/development.md`
2. `docs/architecture.md`
3. `docs/maintenance.md`
4. `docs/command-reference.md`
5. `docs/troubleshooting.md`

Expected result: each guide owns one primary topic and links back to the README or adjacent guides
when readers need more detail.

---

## Step 4 — Roll Out Concise JSDoc Across `src/`

1. Update functions and methods in `src/agents/`, `src/commands/`, `src/config/`, `src/core/`,
   `src/daemon/`, `src/lib/`, and maintained helpers under `src/test-helpers/`.
2. Keep each JSDoc block short and reasoning-led.
3. Add tags only when they improve clarity.

Expected result: source files become easier to scan without feeling over-commented.

---

## Step 5 — Verify Consistency And Quality

Run:

```sh
bun run typecheck
bun run lint
bun run test
```

Then manually verify:

1. README renders the logo correctly.
2. README links to every required guide.
3. Guides use consistent terminology and avoid repeating the same paragraphs.
4. JSDoc remains concise across multiple representative files.

---

## Completion Criteria

- README is a concise navigation hub with the logo.
- Required guides exist and cover development, architecture, maintenance, commands, and troubleshooting.
- Maintained TypeScript functions and methods have concise reasoning-oriented JSDoc.
- Repository checks still pass after the edits.
