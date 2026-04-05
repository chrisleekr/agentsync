# Speckit Local Development Guide

## Purpose

Use this guide when you are maintaining AgentSync's spec-kit setup itself. It covers where the
repo-local workflow assets live, how active feature detection works, how timestamp branches map
to feature directories, and what must change when workflow rules drift.

## Repo-local surface map

| Path | Owns | Why it matters |
| ---- | ---- | -------------- |
| `.github/prompts/` | GitHub Copilot slash-command prompt files such as `speckit.plan.prompt.md` | This is the user-facing command surface for speckit commands in this repo |
| `.github/agents/` | Agent descriptors such as `speckit.plan.agent.md` | These pair with the prompt files and keep command naming consistent |
| `.specify/init-options.json` | Local initialization defaults | Confirms timestamp branch numbering, current-directory init, integration target, and spec-kit version |
| `.specify/integration.json` | Integration-specific hooks | Shows which script updates agent context after planning |
| `.specify/memory/constitution.md` | Repo principles and governance rules | This is the local source of truth for workflow gates and documentation rules |
| `.specify/scripts/bash/` | Shell workflow helpers such as `check-prerequisites.sh` and `create-new-feature.sh` | These scripts implement branch validation, feature-path resolution, and task prerequisites |
| `.vscode/settings.json` | Editor recommendations and terminal auto-approval | Shows which speckit prompts are recommended and which scripts are auto-approved in the terminal |
| `specs/` | Feature directories and planning artifacts | Each active feature lives under `specs/<feature-branch>/` |

## How active feature detection works

The bash helpers under `.specify/scripts/bash/` resolve the active feature in this order:

1. If `SPECIFY_FEATURE` is set, that value wins.
2. Otherwise the scripts use the current git branch from the repo root.
3. If git is unavailable, they fall back to the newest `specs/` directory by timestamp, with a
   numeric-prefix fallback for older layouts.
4. The branch or override is mapped to a feature directory by shared prefix, not only exact name.
   A branch like `20260405-195011-speckit-dev-docs` resolves to `specs/20260405-195011-speckit-dev-docs/`.
5. If multiple feature directories share the same prefix, the scripts stop with an error instead
   of guessing.

Use these commands when you need to inspect the current context:

```bash
.specify/scripts/bash/check-prerequisites.sh --paths-only
.specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks
```

Use `--paths-only` when you want the resolved branch and feature paths quickly.
Use `--json --require-tasks --include-tasks` when you are about to analyze or implement and want
to confirm that the planning artifacts exist.

## Timestamp branches and feature directories

AgentSync uses timestamp branches for new feature work.

- Required format: `YYYYMMDD-HHMMSS-slug`
- Example: `20260405-195011-speckit-dev-docs`
- The repo default is recorded in `.specify/init-options.json`
- The branch rule is enforced by `.specify/memory/constitution.md`

This differs from many upstream examples that still show sequential prefixes. The local rule here
is more important than the example style in upstream screenshots.

When creating a fresh feature through the shell helpers, use the timestamp option:

```bash
.specify/scripts/bash/create-new-feature.sh --timestamp "Improve documentation to guide speckit development"
```

Sequential prefixes still appear in compatibility logic, but new AgentSync work should use the
timestamp format.

## Resume or inspect an in-progress feature safely

1. Resolve the active feature paths:

```bash
.specify/scripts/bash/check-prerequisites.sh --paths-only
```

1. Open the current artifact set in this order:

- `spec.md`
- `plan.md`
- `tasks.md`

1. Choose the next command based on what already exists:

- Spec exists, but no plan: `/speckit.plan`
- Plan exists, but no tasks: `/speckit.tasks`
- Tasks exist, but the artifacts feel inconsistent: `/speckit.analyze`
- Tasks are approved and implementation should start: `/speckit.implement`

1. If your shell is not on the matching feature branch, switch branches before running the next
   command. Use `SPECIFY_FEATURE` only when you need an explicit override for tooling or editor
   context.

## Validate doc changes against official behavior

Use these sources as the order of truth:

1. Official spec-kit docs and repository:
   - installation
   - quickstart
   - local development
   - `github/spec-kit` and `spec-driven.md`
2. AgentSync-local workflow surfaces:
   - `.specify/`
   - `.github/prompts/`
   - `.github/agents/`
   - `.vscode/settings.json`

Before merge:

1. Re-check the local statement against the upstream source.
2. Validate any Mermaid changes.
3. Run `bun run check`.
4. Re-run the manual walkthroughs captured in the active feature quickstart when the change is
   documentation-only.

## Ownership and update triggers

The contributor who changes the workflow surface owns the documentation updates in the same
change. Reviewers use [maintenance.md](maintenance.md) to enforce that rule.

Update the speckit docs when you change any of the following:

| Change type | Update at least | Why |
| ----------- | --------------- | --- |
| Prompt or agent command surface in `.github/` | `docs/speckit.md`, this guide | Command names and examples must stay real |
| Workflow scripts or active-feature resolution in `.specify/scripts/` | this guide | Resume and recovery guidance depends on script behavior |
| Constitution or governance rules | `docs/speckit.md`, `docs/maintenance.md`, this guide | Readers need the updated gates and ownership rules |
| Workflow order or artifact expectations | `docs/speckit.md`, Mermaid diagram, `docs/maintenance.md` | The canonical guide must stay aligned with the real process |
| Repeated contributor confusion around feature recovery | this guide and, if useful, `docs/troubleshooting.md` | Recovery steps should not stay tribal knowledge |

## Common local recovery scenarios

### The feature directory does not match the branch you expected

Run:

```bash
.specify/scripts/bash/check-prerequisites.sh --paths-only
```

If the branch prefix does not resolve to the right `specs/` directory, switch to the correct
feature branch first. If the branch context cannot be used, set `SPECIFY_FEATURE` deliberately
for the session instead of editing scripts.

### You are unsure whether a stage can be re-run

- Re-running `/speckit.clarify`, `/speckit.plan`, `/speckit.tasks`, or `/speckit.analyze` is
  fine when the current artifacts are the right input and you want a better output.
- Re-check the affected artifacts after each rerun instead of assuming earlier conclusions still
  hold.
- If the rerun changes workflow meaning, update the documentation in the same change.

### `.specify/extensions.yml` is absent

That is the normal AgentSync state today. Do not invent extension-specific steps in the default
workflow docs. Treat extensions and presets as advanced layers that need their own explicit docs
once they exist.

### Official docs and local docs seem to drift

Prefer the official workflow order first, then layer AgentSync-specific notes on top. If the repo
intentionally diverges, document the local reason and point to the exact repo file that now owns
the difference.

## Related docs

- [speckit.md](speckit.md)
- [development.md](development.md)
- [maintenance.md](maintenance.md)
- [troubleshooting.md](troubleshooting.md)
