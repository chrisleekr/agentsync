# Research: Released CLI Documentation Refresh

**Branch**: `20260405-213451-released-cli-docs` | **Date**: 2026-04-05

---

## Finding 1 — The README Must Answer Installation And First Use For Released Users

### Evidence For README Scope

`README.md` already contains a released CLI section, prerequisites, a verification command, and a general `bunx` pattern. That confirms the entry page is the intended starting point for released users.

### Decision For README Scope

- **Chosen**: Keep `README.md` as the primary released-user landing page and ensure it clearly answers three questions: how to install or invoke the released CLI, how to use it for first commands, and when readers should follow the released path instead of the contributor path.
- **Rationale**: The entry documentation is where readers first decide whether the project is usable as a released CLI. That decision should not require scanning deeper docs.
- **Alternatives considered**:
  - _Move all released-path details into `docs/command-reference.md`_: Rejected because it forces first-time readers to leave the entry page before they even know the install and verification flow.
  - _Keep only the version-check example in README_: Rejected because it proves resolution but does not fully explain how to use the published CLI.

---

## Finding 2 — The Command Reference Still Describes The Released Surface Incompletely

### Evidence For Command Reference Scope

`docs/command-reference.md` identifies the released CLI path and version-check command, but the per-command usage examples still use bare `agentsync ...` forms without showing the published invocation pattern.

### Decision For Command Reference Scope

- **Chosen**: Update the command reference so released usage examples teach the actual published invocation path, either directly in examples or through one explicit rule that applies to all examples on the page.
- **Rationale**: Released users should not have to infer how bare command examples map onto `bunx --package @chrisleekr/agentsync agentsync ...`.
- **Alternatives considered**:
  - _Leave bare command examples and rely on one intro sentence_: Rejected because it is easy to miss and leaves the highest-frequency part of the page inconsistent with the released path.
  - _Remove all examples_: Rejected because readers need quick operational copy points, not abstract contracts only.

---

## Finding 3 — Source-Oriented Guides Need Stronger Routing Boundaries

### Evidence For Supporting Guide Boundaries

`docs/development.md` correctly describes contributor-from-source work, but `docs/troubleshooting.md` still uses `bun run src/cli.ts ...` examples without early scope labeling for released users. `docs/maintenance.md` defines ownership rules but can still be tightened around which pages must stay aligned when the released path changes.

### Decision For Supporting Guide Boundaries

- **Chosen**: Make the released-versus-source boundary explicit near the top of every affected supporting page and use redirects rather than mixed guidance.
- **Rationale**: Readers often enter through search, deep links, or a doc sidebar, not through README. Each page must be self-scoping enough to prevent mode confusion.
- **Alternatives considered**:
  - _Assume README routing is sufficient_: Rejected because deep-linked docs bypass README.
  - _Duplicate the full released path in every page_: Rejected because it increases maintenance burden and raises the risk of drift.

---

## Finding 4 — GitHub Releases Should Remain The Single Release-Information Surface

### Evidence For Release Source Of Truth

Both `README.md` and `docs/command-reference.md` already point readers to GitHub Releases for version and change information.

### Decision For Release Source Of Truth

- **Chosen**: Preserve GitHub Releases as the canonical release-information source and ensure all affected docs keep referring to the same location.
- **Rationale**: A single release-information surface avoids contradictions between repository docs and published release records.
- **Alternatives considered**:
  - _Repeat version or change summaries across multiple docs_: Rejected because it creates stale documentation risk.
  - _Use npm registry pages as the primary change log surface_: Rejected because the repository already treats GitHub Releases as canonical.

---

## Finding 5 — A Mermaid Diagram Is Not Warranted For This Feature

### Evidence For Diagram Need

The feature changes wording and navigation across existing documentation pages. It does not introduce a new lifecycle, interaction graph, or system structure that becomes materially clearer when visualized.

### Decision For Diagram Need

- **Chosen**: Do not add a Mermaid diagram.
- **Rationale**: The constitution requires diagrams only when they materially improve comprehension. For this feature, a diagram would add maintenance cost without explaining anything that short prose and cross-links cannot already explain more directly.
- **Alternatives considered**:
  - _Add a document-routing flowchart_: Rejected because the routing is simple and already expressed clearly through page purpose notes and “start here” links.
