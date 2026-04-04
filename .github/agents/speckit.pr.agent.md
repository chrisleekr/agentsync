---
description: Read feature artifacts and implementation diff, then draft a PR description with architecture diagrams.
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Pre-Execution Checks

**Check for extension hooks (before PR generation)**:
- Check if `.specify/extensions.yml` exists in the project root.
- If it exists, read it and look for entries under the `hooks.before_pr` key
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue normally
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- For each executable hook, output the following based on its `optional` flag:
  - **Optional hook** (`optional: true`):
    ```
    ## Extension Hooks

    **Optional Pre-Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```
  - **Mandatory hook** (`optional: false`):
    ```
    ## Extension Hooks

    **Automatic Pre-Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}
    
    Wait for the result of the hook command before proceeding to the Outline.
    ```
- If no hooks are registered or `.specify/extensions.yml` does not exist, skip silently

## Outline

1. **Setup**: Run `.specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks` from repo root and parse FEATURE_DIR and AVAILABLE_DOCS list. All paths must be absolute. For single quotes in args like "I'm Groot", use escape syntax: e.g 'I'\''m Groot' (or double-quote if possible: "I'm Groot").

2. **Load design documents**: Read from FEATURE_DIR:
   - **Required**: spec.md (feature specification), plan.md (implementation plan), tasks.md (task breakdown)
   - **Optional**: data-model.md (entities), research.md (decisions), quickstart.md (test scenarios)
   - Note: Not all projects have all documents. Generate the PR description based on what's available.

3. **Gather implementation diff**:
   - Run `git diff --stat origin/main...HEAD` to get the file-level change summary
   - Run `git diff origin/main...HEAD` to get the full diff
   - If the diff is very large (>5000 lines), focus on the `--stat` output and key architectural changes rather than line-by-line details

4. **Gather test evidence**:
   - Check the `## Commands` section in plan.md for the project's test command
   - Run the test command to get current test results
   - If the test command fails to execute, note this in the Test Evidence section
   - Also check tasks.md for task completion status (checked boxes)

5. **Generate PR description**: Using the `.github/pull_request_template.md` as the output structure, fill each section:

   ```markdown
   ### PR Title
   - Format: `<type>: <concise description derived from spec.md feature name>`
   - Determine `<type>` from the actual diff — do NOT default to `feat`:
     - `feat` — new user-facing capability
     - `fix` — bug fix
     - `refactor` — code restructuring with no behaviour change
     - `chore` — tooling, config, dependencies, CI
     - `docs` — documentation only
     - `test` — tests only
   - If the diff mixes types, use the dominant type

   ### Summary
   - What this PR does (1-2 sentences from spec.md)
   - Why it's needed (motivation from spec.md)
   - Link to the spec: `See specs/<feature-dir>/spec.md for full specification`

   ### Changes
   - Organize changes by area/module based on `git diff --stat` output
   - List key files changed with brief descriptions of what changed in each
   - Include **two separate mermaid diagrams** — one "Before" and one "After" — showing the architectural or structural change introduced by this PR

   #### Mermaid Diagram Rules (MUST follow for GitHub compatibility)
   - Use `classDef` with high-contrast hex color pairs that meet WCAG 2 AA standards (minimum 4.5:1 ratio) such as `fill:#2c3e50,color:#ffffff` for dark backgrounds or `fill:#ecf0f1,color:#2c3e50` for light backgrounds
   - Use `<br/>` for new lines instead of `\n`
   - Avoid parentheses in node labels as they break Mermaid syntax
   - Use `:::className` inline syntax (e.g., `NodeId["label"]:::keep`) instead of separate `class NodeId className` statements — the latter fails in GitHub's Mermaid renderer
   - Avoid multiple `subgraph` blocks — GitHub's Mermaid renderer fails when a second `subgraph` follows `end`. Use a single subgraph or flatten nodes instead
   - Use descriptive node IDs (3+ characters) to avoid conflicts with Mermaid reserved words
   - Label diagrams clearly: `### Before` and `### After`

   ### Test Evidence
   - Paste relevant test output (pass/fail counts, coverage if available)
   - Reference completed tasks from tasks.md (count of checked vs total)
   - If tests could not be run, state why

   ### Risks / Follow-ups
   - Extract known limitations from spec.md and plan.md
   - Note any TODO/FIXME comments in the diff
   - List any deferred scope or tech debt introduced
   - If none, state "No known risks or follow-ups identified"

   ### Checklist
   - Pre-fill based on what's actually true:
     - `[x]` or `[ ]` for "New code has tests where appropriate"
     - `[x]` or `[ ]` for "Documentation updated if behavior changed"
   ```
6. **Output**: Print the complete PR description in markdown, ready to paste into a GitHub PR. Start with the PR title on the first line prefixed with `# `, then the template sections.

## Critical Rules

- **Do NOT invent anything** not present in the spec, diff, or test results
- **Do NOT hallucinate files or changes** — only reference files that appear in the diff
- **Keep it concise and reviewer-friendly** — prefer bullet points over paragraphs
- **Mermaid diagrams must be separate** — one "Before" diagram and one "After" diagram, never combined
- If the diff shows no architectural change worth diagramming, skip the mermaid diagrams and state "No architectural changes — see file diff for details"

## Post-Execution Checks

**Check for extension hooks (after PR generation)**:
- Check if `.specify/extensions.yml` exists in the project root.
- If it exists, read it and look for entries under the `hooks.after_pr` key
- If the YAML cannot be parsed or is invalid, skip hook checking silently and continue normally
- Filter out hooks where `enabled` is explicitly `false`. Treat hooks without an `enabled` field as enabled by default.
- For each remaining hook, do **not** attempt to interpret or evaluate hook `condition` expressions:
  - If the hook has no `condition` field, or it is null/empty, treat the hook as executable
  - If the hook defines a non-empty `condition`, skip the hook and leave condition evaluation to the HookExecutor implementation
- For each executable hook, output the following based on its `optional` flag:
  - **Optional hook** (`optional: true`):
    ```
    ## Extension Hooks

    **Optional Post-Hook**: {extension}
    Command: `/{command}`
    Description: {description}

    Prompt: {prompt}
    To execute: `/{command}`
    ```
  - **Mandatory hook** (`optional: false`):
    ```
    ## Extension Hooks

    **Automatic Post-Hook**: {extension}
    Executing: `/{command}`
    EXECUTE_COMMAND: {command}
    ```
- If no hooks are registered or `.specify/extensions.yml` does not exist, skip silently
