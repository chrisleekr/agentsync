# Research: Improve Project Documentation

**Branch**: `20260405-091845-improve-project-docs` | **Date**: 2026-04-05

---

## Finding 1 — The README Must Become a Hub, Not a Manual

### Evidence

The current `README.md` is very short and useful as a starting point, but it only covers a basic
project summary and a minimal quick start. It does not route readers to deeper material, explain
architecture, document maintenance expectations, or use the existing repository branding asset.

### Decision

- **Chosen**: Keep the README concise and turn it into a navigation hub with logo, overview,
  quick start, and links to focused guides.
- **Rationale**: The user explicitly required non-verbose documentation. Concentrating detail in
  dedicated pages avoids inflating the README while still improving discoverability.
- **Alternatives considered**:
  - _Put all content in the README_: Rejected because it conflicts directly with the requirement
    that documentation remain concise.
  - _Leave the README minimal and add guides only_: Rejected because the README is the primary
    entry point and must route readers effectively.

---

## Finding 2 — JSDoc Coverage Is Partial and Needs a Repo-Wide Audit

### Evidence

Repository scan results:

- `src/**/*.ts` files: 53
- exported symbols matched by a fast scan: 109
- existing JSDoc blocks in `src/`: 41

This shows the current JSDoc baseline is incomplete even before counting non-exported maintained
helpers and class methods.

### Decision

- **Chosen**: Treat JSDoc rollout as a first-class workstream covering all maintained TypeScript
  functions and methods in project source.
- **Rationale**: The user's clarification explicitly requires code-level documentation, and the
  constitution already treats JSDoc quality as a governance rule.
- **Alternatives considered**:
  - _Limit JSDoc to exported symbols only_: Rejected because it does not satisfy the clarified
    user requirement.
  - _Add long-form JSDoc everywhere_: Rejected because it violates the concise, reasoning-led
    constraint.

---

## Finding 3 — The Correct Branding Asset Already Exists

### Evidence

The repository already contains `docs/agentsync-logo.png`, which matches the user's attached logo
asset and is available for direct README embedding.

### Decision

- **Chosen**: Use `docs/agentsync-logo.png` in the README with clear alt text and conservative
  placement near the top of the file.
- **Rationale**: Reusing the existing asset avoids unnecessary file churn and satisfies the user's
  branding requirement immediately.
- **Alternatives considered**:
  - _Create a new logo asset or variant_: Rejected as unnecessary.
  - _Link to an external image URL_: Rejected because repository-local assets are more stable and
    render correctly on GitHub.

---

## Finding 4 — The Highest-Value Additional Guides Are Development, Architecture, and Maintenance

### Evidence

The current repository does not contain dedicated Markdown guides beyond feature specs. Yet the
source tree clearly contains multiple contributor-facing concerns that are not self-explanatory:

- CLI entrypoint and command surface in `src/cli.ts` and `src/commands/`
- multi-agent snapshot/apply integrations in `src/agents/`
- security-critical flows in `src/core/encryptor.ts`, `src/core/sanitizer.ts`, and `src/core/git.ts`
- daemon/service behaviour across macOS, Linux, and Windows in `src/daemon/`

### Decision

- **Chosen**: Add dedicated guides for development, architecture, and maintenance.
- **Rationale**: These are the user-mandated pages and cover the main knowledge gaps that the
  current README cannot explain concisely on its own.
- **Alternatives considered**:
  - _Development only_: Rejected because it leaves architecture and upkeep undocumented.
  - _Architecture only_: Rejected because contributors still need operational and maintenance paths.

---

## Finding 5 — Command Reference and Troubleshooting Are the Most Useful Supporting Guides

### Evidence

The CLI exposes at least seven top-level subcommands: `init`, `push`, `pull`, `status`, `doctor`,
`daemon`, and `key`. These create recurring operator questions that do not belong in a short
README. The spec also requires troubleshooting guidance for common setup and operational failures.

### Decision

- **Chosen**: Add `docs/command-reference.md` and `docs/troubleshooting.md` in addition to the
  required guides.
- **Rationale**: These are the highest-value supplements because they answer frequent questions
  without bloating the overview docs.
- **Alternatives considered**:
  - _One combined reference page_: Rejected because command reference and troubleshooting serve
    different lookup behaviours.
  - _Per-command pages_: Rejected as too fragmented for the current project size.

---

## Finding 6 — Concise, Reasoning-Led Documentation Needs an Explicit Writing Rule

### Evidence

The constitution already says documentation must be concise and explain what and why. The user's
clarification strengthens that requirement: all documentation must be concise/reasoning rather than
verbose.

### Decision

- **Chosen**: Standardize on a brief documentation pattern: one compact summary, short rationale or
  constraint when needed, and tags only where they add real signal.
- **Rationale**: Without an explicit rule, the implementation could satisfy coverage while still
  producing low-value, repetitive prose.
- **Alternatives considered**:
  - _Allow free-form prose_: Rejected because the user explicitly asked against verbosity.
  - _Use only ultra-short labels with no reasoning_: Rejected because it would remove the intent
    that the user wants preserved.
