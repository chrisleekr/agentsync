# Phase 1 — Data Model

**Feature**: `20260411-143905-fix-feature-researcher`
**Scope**: No new persisted data. The “entities” below are the
**observable artefacts** of a single workflow run; they exist at
runtime only and are reset on every dispatch.

This feature introduces zero new TypeScript types, zero Zod schemas,
zero file formats. Every entity below already exists; the plan only
changes **which branches of the state machine are reachable**.

---

## Entity 1 — WorkflowRun

The authoritative GitHub Actions run instance created by a
`schedule` or `workflow_dispatch` trigger on
`.github/workflows/feature-research.md`.

### Identity

- **`run_id`** (integer) — GitHub Actions run ID. The 2026-04-10
  failing run was `24232817769`.
- **`run_attempt`** (integer) — attempt number, usually `1`.
- **`head_sha`** (string) — commit SHA that the run executed against.

### State

- **`status`** (enum) — `queued | in_progress | completed`.
- **`conclusion`** (enum) — `success | failure | cancelled | skipped |
  timed_out | action_required | neutral`. **This feature’s entire
  reason for existing is to ensure that `success` is never reported
  when `items_emitted_total == 0` for `create_issue`.**
- **`started_at`**, **`completed_at`** (ISO 8601 timestamps) — feeds
  SC-003 agent-wall-clock measurement.

### Relations

- **has many** `Job` (activation, agent, detection, safe_outputs,
  conclusion — existing gh-aw job topology).
- **has many** `SafeOutputRecord` (via the agent job’s output artefact).

### Validation rules (enforced by this feature)

| Rule | Enforced by |
|------|------------|
| `conclusion == "success"` → `create_issue_count >= 1` OR `noop_count >= 1` | R-3 `post-steps:` assertion injected into agent job |
| `MCP blocked by policy` log line MUST NOT appear for `tavily`, `github`, `safeoutputs` | R-1 workaround (mechanism per TODO(human) decision) |

No rule writes to a database; all validations are ephemeral shell
assertions running inside the runner.

---

## Entity 2 — SafeOutputRecord

A single JSON-encoded record produced by the agent and written to
`/tmp/gh-aw/safeoutputs.jsonl` by the `safeoutputs` MCP server.
Collected into `/tmp/gh-aw/agent_output.json` by gh-aw’s
`collect_ndjson_output.cjs` step.

### Shape (excerpted from current compiled `feature-research.lock.yml`)

```jsonc
{
  "type": "create_issue",        // or "noop" | "missing_data" | "missing_tool"
  "title": "[feature-research] ...",
  "body": "<markdown>",          // max 65_000 chars, sanitized
  "labels": ["feature-research", "automated"],
  "assignees": ["chrisleekr"]
}
```

The schema is **defined by gh-aw itself** and stored in the compiled
lock file under `safeoutputs/validation.json`. This feature MUST NOT
alter that schema; we only assert on its presence.

### Validation rules this feature cares about

| Rule | Current state | Post-fix state |
|------|---------------|----------------|
| `items[].type == "create_issue"` count on a `success` run | Unconstrained (0 was possible → 2026-04-10 silent failure) | MUST be `>= 1` OR at least one `"noop"` record must exist |
| Create-issue labels prefix | `[feature-research]`, labels `feature-research,automated`, assignees `chrisleekr` | UNCHANGED |
| Create-issue max per run | `max: 1` | UNCHANGED |
| `close-older-issues` | `true` | UNCHANGED |
| `expires` | `7d` (168 h) | UNCHANGED |

### Relations

- **belongs to** `WorkflowRun` (via the `agent` artefact download in
  the `safe_outputs` job).

---

## Entity 3 — GapMatrixIssue

The successful happy-path output of the workflow: a GitHub issue
created (or updated) by the `safe_outputs` job.

### Identity

- **`issue_number`** (integer) — assigned by GitHub on creation.
- **`repo`** — `chrisleekr/agentsync`.

### Shape

- **Title**: `[feature-research] <descriptive>`
- **Body**: a markdown table of `(agent, config field, currently
  synced?, priority)` rows, plus source URLs and an implementation
  recommendation. (Required shape from spec FR-005, SC-004.)
- **Labels**: `feature-research`, `automated`.
- **Assignees**: `chrisleekr`.

### Validation rules this feature cares about

| Rule | Source |
|------|--------|
| Title prefix MUST start with `[feature-research]` | spec FR-005 |
| Gap-matrix table on a happy-path run MUST be non-empty AND cite at least one source URL per row | spec SC-004 |
| On “no gaps detected this week” happy-path, MAY be a noop tracking issue instead of a gap matrix | spec User Story 1 scenario 3 |

### Relations

- **created by** a `SafeOutputRecord` of type `create_issue` OR `noop`.
- **belongs to** `WorkflowRun` transitively.

---

## Entity 4 — CopilotCLIVersionPin

A new implicit entity introduced by this feature. It represents
the decision of **which version of `github/copilot-cli` the agent job
installs** on a given run.

### Identity

- Location depends on R-1 Decision:
  - **Option A / D / E** — implicit in the `gh-aw` framework version
    (via `GH_AW_VERSION` env var in the compiled lock file; framework
    `v0.68.1+` pins Copilot CLI to `1.0.21` in its install script).
  - **Option B / D** — explicit in the source `feature-research.md`
    frontmatter as `engine.version: "1.0.21"`.
  - **Option C / E** — implicit; no version pinned, env var workaround
    layered on top.

### Acceptable values

- `1.0.21` — last confirmed working version per
  [`github/gh-aw#25689`](https://github.com/github/gh-aw/pull/25689).
- Any future version that the gh-aw team re-verifies and pins (only
  applies to Options A/D/E).

### Forbidden values

- `1.0.22` — known broken, produces 0-byte output.
- `latest` without an accompanying pin that resolves to a verified
  version.

### Relations

- **controls behaviour of** every `WorkflowRun` on this repo until
  the next recompile/framework upgrade.

---

## What this feature does NOT introduce

- **No database tables.**
- **No new TypeScript interfaces, types, or Zod schemas.**
- **No new files under `src/agents/`** — the spec explicitly flags
  this as Out of Scope.
- **No new config schema in `agentsync.toml`.** The feature does not
  touch AgentSync’s own config.
- **No new CLI flags on the `agent-sync` binary.** AgentSync CLI is
  untouched.

If task phase discovers any of these become necessary, the Principle
II docs-only exception is invalidated and automated test coverage is
required.
