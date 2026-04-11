# Manual Walkthrough — Feature Opportunity Researcher Fix

**Feature**: `20260411-143905-fix-feature-researcher`
**Purpose**: Satisfy Principle II sub-rule 3 (“manual walkthrough
validation steps in the relevant feature artifacts”) and spec FR-008.

This walkthrough is the **sole testing mechanism** for this feature.
There are no automated tests (Principle II docs-only exception
applies). A reviewer running these steps end-to-end confirms both
silent-success prevention (FR-001) and MCP callability restoration
(FR-002).

**Do not skip steps.** Each step establishes a precondition for the
next. If a step fails, stop, fix the underlying issue, and restart at
step 1.

---

## Prerequisites

- [ ] Checked out branch `20260411-143905-fix-feature-researcher`.
- [ ] `gh` CLI authenticated against `chrisleekr/agentsync` with at
      least `actions:write` (for dispatching) and `issues:read`.
- [ ] `gh aw` extension installed. Verify with:
      ```bash
      gh aw version
      ```
- [ ] Local `gh aw` version is **≥ v0.68.1** IF the R-1 decision in
      `research.md` picked option A, D, or E. To upgrade:
      ```bash
      gh extension upgrade gh-aw
      gh aw version    # confirm ≥ v0.68.1
      ```
- [ ] Task phase edits to `.github/workflows/feature-research.md` are
      already applied on the branch.
- [ ] `feature-research.lock.yml` has been regenerated via
      `gh aw compile feature-research --strict` and both files are
      committed in the same commit (the activation job enforces hash
      consistency between them).

## Step 1 — Sanity: `bun run check` passes

Required by Principle II docs-only exception sub-rule 1.

```bash
bun run check
```

- [ ] Exits `0` with no TypeScript, lint, or test errors. If it
      fails, investigate before proceeding.

## Step 2 — Validate the Mermaid diagram in `plan.md`

Required by Principle II docs-only exception sub-rule 2.

- [ ] Open `specs/20260411-143905-fix-feature-researcher/plan.md` in
      a GitHub-rendered preview (either on github.com or a local
      preview tool that uses GFM Mermaid).
- [ ] Confirm the Run State Diagram renders without a syntax error
      banner.
- [ ] Confirm every node is readable (text contrast looks like dark
      text on light background or vice versa — not a low-contrast
      combo).
- [ ] If the diagram fails to render, read the global `CLAUDE.md`
      Mermaid rules and fix syntax before continuing.

## Step 3 — Dispatch the workflow on the fix branch (happy path)

```bash
gh workflow run feature-research.lock.yml \
  --ref 20260411-143905-fix-feature-researcher
```

Wait for the run to start, then:

```bash
RUN_ID=$(gh run list --workflow=feature-research.lock.yml \
  --branch 20260411-143905-fix-feature-researcher \
  --limit 1 --json databaseId -q '.[0].databaseId')
echo "run: $RUN_ID"
gh run watch "$RUN_ID"
```

### Expected

- [ ] **Overall run conclusion**: `success` (green check in Actions UI).
- [ ] **`activation` job**: green.
- [ ] **`agent` job**: green. Log does NOT contain:
      ```
      ! N MCP servers were blocked by policy
      ```
      for any of `tavily`, `github`, `safeoutputs` (spec FR-002).
- [ ] **`agent` job log**: does NOT contain `bun run check`,
      `bun install`, `npm test`, or any other build/validation
      command (spec FR-004).
- [ ] **`agent` job log**: shows at least one successful
      `mcp__tavily__search` tool call with results returned
      (spec User Story 2 acceptance scenario 2).
- [ ] **New post-steps assertion**: visible in the agent job as
      a step named something like “Assert agent emitted at least one
      safe-output record”, exits `0`.
- [ ] **`detection` job**: green (runs only because a safe-output
      was emitted).
- [ ] **`safe_outputs` job**: green.
- [ ] **`conclusion` job**: green.
- [ ] **New issue created on `chrisleekr/agentsync/issues`** with:
      - Title prefix `[feature-research]`
      - Labels `feature-research`, `automated`
      - Assignee `chrisleekr`
      - Body contains the gap matrix table (columns: agent, config
        field, currently synced?, priority) OR the “No gaps detected
        this week” noop message.
- [ ] **Prior week’s feature-research issue** is now `closed` (by
      the `close-older-issues: true` mechanism).

### If any checkbox fails

Stop. Capture the failing log lines and job IDs. Decide whether:
(a) the fix is incomplete (go back to task phase), or (b) the spec
needs an additional acceptance scenario. Do NOT mark the feature
complete.

## Step 4 — Measure wall-clock against SC-003

- [ ] Record the `agent` job duration from step 3. Target: **≤ 8
      minutes median** across 4 runs. A single run over 8 minutes is
      acceptable if the next 3 scheduled runs average under. (SC-003
      is measured across 4 scheduled runs post-merge, not a single
      dispatch.)

## Step 5 — Forced failure walkthrough (sad path — FR-001)

This step verifies that the new post-steps assertion actually fires
when the agent cannot emit safe-outputs. **This MUST be done with a
disposable/throwaway secret — do not break the real TAVILY_API_KEY.**

### Setup

1. In repo Settings → Secrets and variables → Actions, note the
   current value of `TAVILY_API_KEY` (you’ll restore it).
2. Overwrite `TAVILY_API_KEY` with an invalid value like `tvly-INVALID`.

### Dispatch

```bash
gh workflow run feature-research.lock.yml \
  --ref 20260411-143905-fix-feature-researcher
```

### Expected

- [ ] **Overall run conclusion**: `failure` (red X in Actions UI).
- [ ] **`agent` job**: FAILS. The new post-steps assertion fires
      with a `::error::` workflow annotation: “FR-001 violation —
      agent emitted zero create_issue and zero noop safe-outputs”.
- [ ] **`conclusion` job**: rolls up as failure.
- [ ] **NO new `[feature-research]` issue is created** (the
      safe_outputs job is skipped because agent failed).
- [ ] The maintainer can see the red X **on the Actions runs page
      without opening any individual run log** (spec SC-005).

### Restore

1. Restore the original `TAVILY_API_KEY` value.
2. Confirm by running step 3 again — it MUST pass on the restored
   secret (this re-verification catches the “did I actually restore
   it correctly?” mistake).

## Step 6 — Confirm lock-file hash guardrail still works

FR-007 requires we not regress the existing compile-version check.

- [ ] Hand-edit `feature-research.lock.yml` (add a trailing comment
      or space somewhere). DO NOT commit.
- [ ] Dispatch the workflow again.
- [ ] Expect the **activation job** to FAIL with a hash-mismatch
      error (this is the existing `[hash-debug]` mechanism from
      gh-aw v0.68.1).
- [ ] `git restore .github/workflows/feature-research.lock.yml` to
      revert the hand-edit.
- [ ] Re-dispatch, confirm green.

## Step 7 — Document the walkthrough result

- [ ] Add a brief note to the PR description (not this file) stating
      the walkthrough was performed, the run IDs used, and that
      every checkbox above was checked. The PR description is where
      the record of the manual walkthrough lives for reviewers.

## Post-merge observability window (SC-001, SC-002)

These are **not gating** for PR merge, but the spec requires observing
them across 4 scheduled weekly runs. Create a tracking issue or
calendar reminder to check:

- [ ] **4/4 scheduled runs** over the next 4 Fridays land in one of
      the two healthy end-states (gap matrix issue, or noop issue).
- [ ] **4/4 runs** show `mcp__tavily__search` tool calls in the
      agent log.
- [ ] **Median agent wall-clock ≤ 8 minutes** across the 4 runs.

If any of these regresses, reopen this spec.

---

## Rollback procedure

If the fix breaks production (e.g. the post-steps assertion fires
incorrectly and blocks legitimate success), roll back with:

```bash
git revert <merge-commit-sha>
gh aw compile feature-research --strict   # regenerate lock from reverted source
git commit -am "revert(workflow): rollback feature-research fix"
git push origin main
```

The weekly schedule will resume on whatever the previous (broken but
now documented) behavior was, and a new spec can be opened to
diagnose what went wrong with the fix.
