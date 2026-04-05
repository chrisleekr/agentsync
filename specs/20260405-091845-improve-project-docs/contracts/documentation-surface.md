# Contract: Documentation Surface

**Branch**: `20260405-091845-improve-project-docs` | **Date**: 2026-04-05

This contract defines the observable documentation interface for the repository: what readers must
find in the README, which supporting guides must exist, and how JSDoc coverage must behave in the
source tree.

---

## Contract 1 — README Entry Experience

### Required Elements

| Element     | Requirement                                                                |
| ----------- | -------------------------------------------------------------------------- |
| Logo        | `README.md` must embed `docs/agentsync-logo.png` with meaningful alt text  |
| Overview    | README must explain what AgentSync is in a compact summary                 |
| Quick start | README must surface the first-run path without requiring source inspection |
| Navigation  | README must link directly to deeper guides                                 |

### Behaviour

- A repository visitor should be able to identify the product, confirm the brand asset, and find
  deeper documentation from the README alone.
- The README must stay concise; detailed explanations belong in `docs/` pages.

---

## Contract 2 — Required Guide Set

The following pages must exist after implementation:

| Path                        | Audience               | Minimum Contract                                  |
| --------------------------- | ---------------------- | ------------------------------------------------- |
| `docs/development.md`       | contributor            | setup, scripts, checks, local workflow            |
| `docs/architecture.md`      | contributor/maintainer | module map, major flows, security boundaries      |
| `docs/maintenance.md`       | maintainer             | when docs/JSDoc must be updated, review checklist |
| `docs/command-reference.md` | operator/contributor   | concise reference for user-facing commands        |
| `docs/troubleshooting.md`   | operator/contributor   | common failures and next diagnostic step          |

### Navigation Rules

- Each required guide must be linked from `README.md`.
- Guides may cross-link to one another when it reduces repetition.
- No guide should duplicate another guide's source-of-truth content wholesale.

---

## Contract 3 — JSDoc Coverage

### Scope

Applies to maintained TypeScript exports in project source files under `src/`, plus workflow-significant internal helpers.

### Required Behaviour

- Each in-scope symbol must have one concise JSDoc block immediately above it.
- JSDoc must explain what the symbol does and why it exists, or call out non-obvious constraints.
- Tags such as `@param`, `@returns`, and `@throws` must be used when they add clarity, not as filler.

### Minimum Required Scope

- All exported functions, classes, interfaces, and types in maintained production source
- Maintained internal helpers when they carry workflow, safety, or integration meaning

### Prohibited Behaviour

- Boilerplate comments that merely restate the function name
- Multi-paragraph narrative blocks that make the source harder to scan
- Stale comments that describe prior behaviour

---

## Contract 4 — Concision Standard

All new or updated repository-hosted documentation and JSDoc must follow the same style contract:

- Start with the smallest explanation that still preserves intent.
- Prefer compact rationale over exhaustive narration.
- Move detailed lookup material into focused guides rather than expanding the README endlessly.

---

## Contract 5 — Verification Surface

Implementation is considered compliant when:

1. README renders with logo and working guide links.
2. The required guide set exists and covers its intended audience.
3. JSDoc coverage across maintained source is complete and stylistically consistent.
4. `bun run check` passes after documentation and comment edits.
