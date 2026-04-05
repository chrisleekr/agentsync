# Contract: Speckit Documentation Surface

## Purpose

Define the required documentation surfaces, section coverage, and quality rules for the speckit
guidance added to AgentSync.

## Required Surfaces

### 1. README Navigation Entry

- **Path**: `README.md`
- **Audience**: First-time repository readers
- **Must provide**:
  - A short explanation that this repository uses spec-kit for feature workflow
  - A direct link to the primary speckit guide
  - A direct link to the local-development guide
  - Enough context for readers to know which link to follow first

### 2. Canonical Speckit Guide

- **Path**: `docs/speckit.md`
- **Audience**: Contributors starting or continuing feature work
- **Must provide**:
  - What spec-kit is and why it exists in this repo
  - Prerequisites and initialization modes grounded in official docs
  - A Mermaid workflow diagram that mirrors the official process order from installation through implementation
  - The standard workflow sequence from constitution through implementation
  - When and how to use each command
  - When optional commands such as `clarify`, `checklist`, and `analyze` are useful
  - A feature artifact map with expected outputs
  - At least one AgentSync-specific end-to-end example
  - Guidance for resuming work from an existing branch
  - A short note on extensions and presets as advanced topics

### 3. Speckit Local Development Guide

- **Path**: `docs/speckit-local-development.md`
- **Audience**: Maintainers and contributors updating speckit-related repo assets
- **Must provide**:
  - Where prompt files, agent files, and `.specify/` assets live
  - How active feature context is derived from the branch
  - How local timestamp branches map to feature directories
  - How to inspect, resume, and validate in-progress features
  - How to keep the docs current when upstream workflow or local conventions change
  - Common local maintenance and recovery scenarios

### 4. Existing Docs Integration

- **Paths**: `docs/development.md`, `docs/maintenance.md`, optionally `docs/troubleshooting.md`
- **Audience**: Contributors already navigating current docs
- **Must provide**:
  - Clear links to the new speckit guides where relevant
  - No duplicated long-form workflow explanations that can drift
  - Consistent terminology with the new guides

## Command Coverage Contract

The documentation set must cover these commands explicitly:

- `specify init`
- `/speckit.constitution`
- `/speckit.specify`
- `/speckit.clarify`
- `/speckit.checklist`
- `/speckit.plan`
- `/speckit.tasks`
- `/speckit.analyze`
- `/speckit.implement`

For each command, the docs must answer:

- What the command is for
- When to use it
- What input the contributor should provide
- What output or artifact should result
- What the next likely step is

## Mermaid Diagram Contract

- The canonical speckit guide must include at least one Mermaid flowchart.
- The mainline order in that flowchart must match the official quickstart sequence: `specify init`, `/speckit.constitution`, `/speckit.specify`, `/speckit.clarify`, `/speckit.plan`, `/speckit.tasks`, and `/speckit.implement`.
- `checklist` and `analyze` may appear only as optional validation paths, not as mandatory mainline stages.
- The diagram must use labels that are understandable without prior knowledge of the repo.
- The diagram must validate successfully with Mermaid syntax tooling before merge.

## Example Quality Contract

- Examples must be specific to AgentSync or to realistic maintenance of this repository.
- Examples must avoid speculative workflow paths not present in official spec-kit docs.
- Examples must prefer GitHub Copilot slash commands because this repo exposes `.github/prompts/` and `.github/agents/` surfaces for them.
- Examples may mention upstream agent naming differences only as a short note, not the main path.
- Examples must stay concise and explain why the example is useful.

## Accuracy Contract

- Official spec-kit installation, quickstart, and local-development docs are the source of truth for upstream workflow behavior.
- Repo files under `.specify/`, `.github/prompts/`, `.github/agents/`, and `.vscode/settings.json` are the source of truth for AgentSync-local conventions.
- The docs must explicitly note that this repo uses timestamp branch naming.
- The docs must explain baseline workflow behavior even when no `.specify/extensions.yml` is present.
- The Mermaid workflow diagram must reflect the official process before any repo-local notes are layered on top.

## Navigation Contract

- Readers must be able to go from `README.md` to the canonical speckit guide in one click.
- Readers must be able to go from the canonical speckit guide to the local-development guide in one click.
- Maintainer-facing docs must link back to the main guide instead of restating onboarding flow.

## Review Contract

- Reviewers must be able to check command coverage, artifact coverage, and example accuracy without reading source code.
- Reviewers must be able to compare the Mermaid diagram against the official quickstart stages without inferring missing steps.
- Terminology for `feature`, `stage`, `artifact`, `active feature`, and `readiness` must stay consistent across all updated pages.
