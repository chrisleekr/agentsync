# Feature Specification: Fix Feature Opportunity Researcher Workflow Silent Failure

**Feature Branch**: `20260411-143905-fix-feature-researcher`
**Created**: 2026-04-11
**Status**: Draft
**Input**: User description: "Fix GitHub Agentic workflow https://github.com/chrisleekr/agentsync/actions/runs/24232817769"

## Background

The **Feature Opportunity Researcher** is a scheduled GitHub Agentic Workflow
(`.github/workflows/feature-research.md`) that runs weekly to detect newly
released configuration fields in upstream AI agent tools (Cursor, Claude Code,
GitHub Copilot, Codex, VS Code) and opens a GitHub issue describing the gaps
that AgentSync would need to close.

On **2026-04-10** the scheduled run
[actions/runs/24232817769](https://github.com/chrisleekr/agentsync/actions/runs/24232817769)
completed with conclusion `success`, yet produced **no output** — no issue,
no gap matrix, no health signal.

### Verified root causes

The agent-job log (`gh run view --job 70748164402 --log`) contains enough
evidence to pinpoint three independent problems. The first is the primary
cause; the other two make the primary cause indistinguishable from success.

1. **Copilot CLI v1.0.22 produced 0-byte output, blocking every MCP server
   on this run.** The MCP gateway reported all three servers healthy
   (`✓ tavily: connected`, 78 ms server check) at 07:57:35. Seventeen
   seconds later, after Copilot CLI started, the log shows
   `! 3 MCP servers were blocked by policy: 'github', 'safeoutputs', 'tavily'`.
   The run installed `GitHub Copilot CLI 1.0.22` via
   `copilot-cli/releases/latest/download/copilot-linux-x64.tar.gz`. This CLI
   version has a confirmed regression: the
   [`github/gh-aw` v0.68.1 release notes](https://github.com/github/gh-aw/releases/tag/v0.68.1)
   (published 2026-04-10T19:52:21Z, ≈12 hours after our failing run) describe
   it as *"workflows that were hanging indefinitely or producing **0-byte
   output** due to incompatibilities with v1.0.22. v1.0.21 is the last
   confirmed working version."* The framework fix landed in
   [`github/gh-aw#25689`](https://github.com/github/gh-aw/pull/25689), which
   pins the install script to Copilot CLI v1.0.21. The earlier personal-
   account allowlist bugs
   [`github/copilot-cli#2479`](https://github.com/github/copilot-cli/issues/2479)
   and [`#2481`](https://github.com/github/copilot-cli/issues/2481) — which
   this spec originally cited — were already CLOSED as completed on
   2026-04-09 and 2026-04-03 respectively (#2479 was fixed in CLI v1.0.19
   per @JoannaaKL's comment), so those pre-existing bugs are NOT the root
   cause of the 2026-04-10 failure.

2. **The agent improvised a `bun run check` repo-validation step that the
   prompt never asked for.** The prompt file
   `.github/workflows/feature-research.md` only instructs the agent to read
   `src/agents/*.ts` and compare against upstream changelogs — there is no
   mention of running repository validation. Yet the agent log shows it
   invoking a shell step named *"Check repo status and run baseline
   validation"* with the command
   `git --no-pager status --short && bun run check`. The GitHub-hosted
   `ubuntu-24.04` runner does not have Bun installed, so this improvised
   validation failed, and the agent spent tokens reasoning about the failure
   before eventually moving on.

3. **The overall run was reported as `success` despite producing zero
   safe-output records.** Because the blocked `safeoutputs` MCP was the only
   channel through which the agent could emit a `create-issue` safe-output,
   the agent had no way to deliver findings even though it eventually
   scraped changelog data via raw Python `urllib` calls to GitHub APIs. With
   no safe-outputs emitted, the downstream `detection` and `safe_outputs`
   jobs were **skipped** via their `if:` conditions, and the `conclusion`
   job rolled the run up as `success`. From the Actions UI a reader sees a
   green check mark and reasonably assumes "no gaps this week", when in
   reality the run never completed its task.

The net effect is a **silent failure** of the weekly research automation,
and the three causes compound: #1 breaks the research path, #2 wastes the
agent's budget on a made-up dead end, and #3 hides the whole problem behind
a green check mark.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Silent-success is impossible (Priority: P1)

As the AgentSync maintainer, when the Feature Opportunity Researcher workflow
runs on its weekly schedule, I need the run to either produce the expected
gap-matrix issue **or** end with a clearly-failing (red X) run status. A
completed run that reports `success` but creates no output must never happen
again.

**Why this priority**: Silent success is worse than a loud failure. A silent
run erodes trust in the whole automation and means feature-gap detection
can stall undetected for weeks. Fixing this removes the false-positive "all
good" signal that caused the 2026-04-10 incident.

**Independent Test**: Manually trigger the workflow via `workflow_dispatch`
in an environment where the MCP servers are deliberately made unreachable
(e.g. by temporarily pointing to an invalid gateway). The run must end with
overall conclusion `failure` — the red X must appear in the Actions UI so
the maintainer notices it on the normal Actions-runs screen. It must NOT
end with conclusion `success` and zero safe-output records.

**Acceptance Scenarios**:

1. **Given** the workflow is dispatched and the MCP servers are reachable
   and callable by Copilot CLI,
   **When** the agent completes research,
   **Then** exactly one gap-matrix issue labelled `feature-research,automated`
   is created (or updated, per the existing `close-older-issues` config) and
   the overall run conclusion is `success`.
2. **Given** the workflow is dispatched and the agent is unable to emit any
   safe-output records,
   **When** the agent job finishes,
   **Then** the overall run conclusion is `failure` (red X in the Actions
   UI), NOT `success`.
3. **Given** a prior week's gap-matrix issue exists and the current week has
   no new gaps,
   **When** the workflow runs successfully end-to-end,
   **Then** the agent emits the documented "No gaps detected this week"
   message in a new issue (which the existing `expires: 7d` +
   `close-older-issues` mechanism will supersede the previous week), and
   this state is distinguishable from the failure state in scenario 2 both
   by run conclusion (`success`) and by the existence of a new issue.

---

### User Story 2 - Tavily (and the other configured MCP servers) must be callable by the agent (Priority: P1)

As the AgentSync maintainer, I need the agent to actually be able to call
the `mcp__tavily__search` tool that the workflow's `mcp-servers` section
configures. Tavily is the prescribed research path; the workflow has no
reason to exist if that path is blocked before the agent even reads the
prompt.

**Why this priority**: This is co-P1 with Story 1. Story 1 prevents silent
success on future MCP-block incidents, but the underlying Copilot-CLI
personal-account allowlist bug will keep recurring every run until it is
worked around. Without Story 2 the workflow will keep failing loudly every
week instead of silently, which is an improvement but is not the fix the
stakeholder asked for.

**Independent Test**: Dispatch the workflow on the fix branch and inspect
the agent log. The line
`! N MCP servers were blocked by policy: …` must NOT appear for `tavily`,
`github`, or `safeoutputs`. The agent must successfully invoke
`mcp__tavily__search` at least once in the run, and the log must show at
least one tavily result coming back.

**Acceptance Scenarios**:

1. **Given** the workflow is dispatched on a personal-account repository
   (this repo, `chrisleekr/agentsync`),
   **When** Copilot CLI starts inside the agent job,
   **Then** none of the three configured MCP servers (`github`,
   `safeoutputs`, `tavily`) are reported as "blocked by policy" in the
   agent log.
2. **Given** the MCP servers are callable,
   **When** the agent executes the prompt,
   **Then** the log shows at least one successful `mcp__tavily__search`
   tool call, with results returned.
3. **Given** the upstream Copilot-CLI allowlist bug is later fixed in a
   newer CLI release,
   **When** the workflow is dispatched on that later version,
   **Then** the fix applied in this feature MUST NOT break the workflow
   (i.e. the workaround must be forward-compatible, not version-pinned in a
   way that blocks future upgrades).

---

### User Story 3 - Prompt does not ask the agent to improvise tooling (Priority: P2)

As the AgentSync maintainer, I need the prompt to be explicit about what
the agent should and should not do, so the agent does not waste its token
budget on improvised "baseline validation" commands that neither the prompt
asked for nor the runner supports.

**Why this priority**: This is lower priority than Stories 1 and 2 because
it is a budget/efficiency fix, not a correctness fix — even with this in
place, Stories 1 and 2 are what make the workflow deliver value. But
without this fix, the agent will continue to burn continuation budget on
self-invented dead ends, reducing the quality of the actual research.

**Independent Test**: Dispatch the workflow and inspect the agent log. The
agent must not invoke any shell command that runs repo build/test/validation
tooling (e.g. `bun run check`, `npm test`, `bun install`). Only the
read-only and research tool calls the prompt actually asks for should
appear.

**Acceptance Scenarios**:

1. **Given** the fix is merged,
   **When** the agent executes the prompt,
   **Then** the agent does not invoke `bun run check`, `npm run check`, or
   any equivalent repository-validation command, because the prompt
   explicitly tells it the research task is read-only and does not require
   running repository tests.
2. **Given** a future change adds new agent adapters under `src/agents/`,
   **When** the feature-research workflow runs next,
   **Then** the agent still does not improvise validation commands — the
   prompt's read-only scope covers the new files without further updates.

---

### User Story 4 - Scheduled cadence resumes reliably (Priority: P3)

As the AgentSync maintainer, after the fix is merged I expect the following
Friday scheduled run to deliver a usable output — the routine weekly signal
the workflow was designed for — so I can plan sync work based on it.

**Why this priority**: This is the "return to baseline operation" proof. It
is lower priority than Stories 1-3 because those cover the hardening
required; Story 4 is the post-deployment validation that the hardening held
up under the real weekly trigger.

**Independent Test**: Observe the first Friday scheduled run after merge.
Confirm the run's conclusion and output match one of the two healthy end
states (gap-matrix issue created, or "No gaps detected this week" issue)
rather than either the silent-success state (2026-04-10 regression) or the
loud-failure state (Story 1 safety net firing — indicating Story 2 did not
stick).

**Acceptance Scenarios**:

1. **Given** the fix has been merged and the next weekly schedule fires,
   **When** the run completes,
   **Then** the overall run conclusion is `success` AND at least one
   feature-research issue exists that post-dates the run's start time.

---

### Edge Cases

- **MCP gateway healthy but Copilot CLI blocks every server**: exactly the
  2026-04-10 scenario. Covered by Story 2.
- **Tavily rate-limits mid-run after a few successful calls**: the agent
  may get partial data. Treat as "success with whatever the agent was able
  to retrieve" — the agent emits an issue describing the partial findings
  and explicitly notes the rate-limit. Distinct from Story 1's zero-output
  failure state.
- **Agent exhausts its `max-continuations: 3` budget before producing a
  safe-output**: same consequence as "no output produced" — must trigger
  Story 1's loud-failure path.
- **Upstream Copilot CLI releases a version that fixes the MCP allowlist
  bug and renders the workaround unnecessary**: the fix must remain
  forward-compatible; the workaround should not break or actively harm a
  fixed CLI.
- **Upstream changelogs are reachable but report no new entries in the
  past 7 days**: legitimate "No gaps detected this week" path. Distinct
  from all failure states.
- **Workflow file itself is syntactically valid but the compiled
  `feature-research.lock.yml` is stale**: the existing `Check compile-agentic
  version` step guards against this; the fix must not regress it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The workflow MUST NOT finish with overall conclusion `success`
  while also emitting zero safe-output records of the type the workflow is
  designed to produce (`create-issue` in this case). On a zero-safe-output
  run, the workflow MUST end with overall conclusion `failure` so the
  Actions UI shows a red X.
- **FR-002**: The agent MUST be able to call the MCP servers the workflow
  configures under `mcp-servers:` (`tavily`). The Copilot CLI v1.0.22
  regression that produces 0-byte output (confirmed in the
  [`github/gh-aw` v0.68.1 release notes](https://github.com/github/gh-aw/releases/tag/v0.68.1)
  and fixed in [`github/gh-aw#25689`](https://github.com/github/gh-aw/pull/25689))
  MUST be worked around in the workflow itself — via the framework-level
  pin of Copilot CLI to v1.0.21 — not left to be hit and re-diagnosed on
  every run.
- **FR-003**: Any Copilot-CLI workaround the fix applies MUST be
  forward-compatible: if a future Copilot CLI release fixes the underlying
  bug, the workaround must not break the workflow. (For example, disabling
  an experimental allowlist feature flag remains safe even after the
  non-experimental implementation lands.)
- **FR-004**: The workflow prompt MUST explicitly scope the agent to
  read-only research. It MUST NOT leave the agent to infer whether
  repository build/test/validation commands are appropriate — the prompt
  must say they are not.
- **FR-005**: The workflow MUST continue to honour its existing
  safe-outputs contract — issue label prefix `[feature-research]`, labels
  `feature-research,automated`, assignee `chrisleekr`,
  `close-older-issues: true`, `expires: 7d` — for the normal-success path.
  The fix must not silently change any of these existing behaviours.
- **FR-006**: The workflow MUST remain schedulable on its existing weekly
  trigger (`weekly on friday around 5pm utc+10`) and retain
  `workflow_dispatch` for manual runs. The engine (`copilot`), model
  (`gpt-5.4`), and `max-continuations: 3` remain the operating parameters
  unless a clarification explicitly changes them.
- **FR-007**: The fix MUST NOT relax the existing MCP-gateway integrity
  settings (`min-integrity='approved'`, `repos='all'`) that gh-aw
  auto-applies for public repositories, nor disable any security guardrail
  unrelated to the personal-account allowlist bug. The security posture
  must not regress as a side-effect of making the workflow work.
- **FR-008**: The fix MUST be verifiable by at least one manual walkthrough
  step, documented in this spec or the plan, that the maintainer can run
  end-to-end to confirm both the silent-success prevention (FR-001) and
  the MCP-callability restoration (FR-002).

### Key Entities *(include if feature involves data)*

- **Workflow run**: A single execution of Feature Opportunity Researcher,
  identified by its GitHub Actions run ID. Produces jobs (`activation`,
  `agent`, `detection`, `safe_outputs`, `conclusion`), an overall conclusion,
  zero or more artefacts, and zero or more safe-output records.
- **Gap-matrix issue**: The normal successful output — a GitHub issue whose
  body contains a table of `(agent, config field, currently synced?,
  priority)` rows, source-link references, and an implementation
  recommendation.
- **Safe-output record**: A single write emitted by the agent to the
  `safeoutputs` MCP server. The `create-issue` safe-output type is the
  channel through which this workflow produces its one artefact per run.
- **Known sync targets baseline**: The hard-coded snapshot in the prompt
  describing what `src/agents/*.ts` files currently sync; the agent compares
  upstream changelog findings against this baseline.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Across the next four scheduled weekly runs following the fix,
  zero runs end in the silent-success state (conclusion `success` with zero
  safe-output records). Target: 4/4 runs land in one of the two defined
  healthy end-states (findings issue, or "no new gaps this week" issue).
- **SC-002**: Across the same four scheduled runs, the agent-job log shows
  a successful `mcp__tavily__search` call in 4/4 runs — i.e. the MCP
  allowlist bug is worked around durably, not just on the first post-fix
  run.
- **SC-003**: The agent-job wall-clock time on a successful run drops
  measurably below the 11m29s observed on 2026-04-10 (because the agent no
  longer burns budget on improvised `bun run check` attempts and on raw
  Python `urllib` fallbacks when its prescribed tool is blocked).
  Target: ≤ 8 minutes median across the next four runs.
- **SC-004**: The successful-path run (upstream changelogs reachable via
  Tavily, new entries found) produces a gap-matrix issue whose table is
  non-empty and cites at least one source URL per row — i.e. the fix does
  not regress the normal-path output quality.
- **SC-005**: If a future failure mode does occur (e.g. Tavily is down or
  the secret is revoked), the maintainer becomes aware of it the moment
  they look at the Actions runs page (a red X is visible), without having
  to open the run log.

## Assumptions

- Ownership of `.github/workflows/feature-research.md` and its generated
  `feature-research.lock.yml` stays with this repository; no upstream gh-aw
  framework changes are required to land the fix.
- The weekly schedule and workflow purpose (detect new upstream agent
  config fields) are unchanged; only reliability, correctness of silent-
  success signalling, and prompt discipline are in scope.
- The `TAVILY_API_KEY` repository secret remains valid and available; the
  2026-04-10 failure was NOT caused by an expired or missing API key — the
  MCP gateway successfully initialised the Tavily server with the secret
  at 07:57:35 before Copilot CLI blocked it at 07:57:52.
- The fix pins Copilot CLI at the gh-aw framework level (via
  `gh-aw v0.68.1` / PR [`#25689`](https://github.com/github/gh-aw/pull/25689)),
  which is version-specific, not account-type-specific. The workaround
  therefore holds regardless of whether `chrisleekr/agentsync` remains a
  personal account or is later migrated to an organisation. The earlier
  personal-account 404 theory
  ([`#2479`](https://github.com/github/copilot-cli/issues/2479),
  [`#2481`](https://github.com/github/copilot-cli/issues/2481)) is
  superseded — those bugs were closed as fixed (2026-04-09 and
  2026-04-03 respectively) before the 2026-04-10 failing run, and
  `#2479` was fixed in CLI v1.0.19.
- The runner image will continue to be GitHub-hosted `ubuntu-24.04` (or
  whatever the current gh-aw default is); self-hosted runners are out of
  scope.
- The existing `safe-outputs.create-issue` contract (labels, assignee,
  `close-older-issues`, `expires: 7d`) remains the desired shape for the
  happy-path output.
- Rewriting the workflow to use a different agent CLI (e.g. Claude Code
  instead of Copilot CLI) is out of scope; the fix targets the current
  `engine: copilot / model: gpt-5.4` configuration.
- The fix is expected to be workflow-and-lock-file-only. No changes to
  `src/agents/*.ts` or other runtime source code are expected.

## Documentation Impact

This feature qualifies for the documentation-only testing exception under
the constitution **iff** the final fix touches only
`.github/workflows/feature-research.md`,
`.github/workflows/feature-research.lock.yml` (regenerated), and this spec
tree under `specs/20260411-143905-fix-feature-researcher/`. If the fix
requires changes to any runtime source, exported symbol, configuration
schema, packaging, CI, or generated workflow-script behaviour **other
than** the feature-research workflow's own lock file, automated test
coverage will be required per the constitution.

**Manual walkthrough validation steps reviewers must run**:

1. Dispatch the workflow manually via GitHub UI (`workflow_dispatch`) on
   the fix branch. Inspect the agent job log and confirm:
   - No `! N MCP servers were blocked by policy` line for tavily, github,
     or safeoutputs.
   - At least one successful `mcp__tavily__search` call with returned
     results.
   - No `bun run check` or other improvised validation command.
   - Exactly one feature-research issue created or updated at the end.
2. Simulate the silent-success regression path: temporarily invalidate
   `TAVILY_API_KEY` (or point the gateway at an unreachable URL), dispatch
   again, and confirm the run ends with conclusion `failure` (red X) —
   not `success`. Restore the secret afterwards.
3. Confirm the compile-agentic version check in the activation job still
   enforces `feature-research.lock.yml` freshness (no regression to the
   existing guardrail).

A Mermaid diagram covering the healthy end-states and the red-X failure
state will be added in the plan phase, not in this spec.

## Dependencies

- `.github/workflows/feature-research.md` (source workflow file).
- `.github/workflows/feature-research.lock.yml` (auto-generated — must be
  regenerated via the same compile-agentic version step already present in
  the activation job).
- `TAVILY_API_KEY` repository secret (already configured; no change
  expected).
- gh-aw framework's safe-outputs contract (`create-issue` type) — existing
  behaviour must be preserved.
- gh-aw firewall / MCP-guard defaults for public repositories — existing
  security posture must NOT be relaxed to work around the issue.
- Upstream Copilot CLI release channel (`copilot-cli/releases/latest`).
  The fix must not pin to a specific buggy version; it must tolerate
  whichever `latest` gh-aw installs on a given run.

## Out of Scope

- Rewriting the workflow in a different agent CLI.
- Changing the schedule or the list of upstream tools being monitored.
- Adding new agent adapters to `src/agents/`.
- Modifying the AgentSync CLI, TypeScript source, tests, or published
  package.
- Fixing other unrelated gh-aw workflows in `.github/workflows/`.
- Submitting an upstream fix to Copilot CLI for
  [#2479](https://github.com/github/copilot-cli/issues/2479) /
  [#2481](https://github.com/github/copilot-cli/issues/2481). This spec
  tracks the AgentSync-side workaround only.

## Clarifications Resolved

The following open questions were resolved during specification review
(2026-04-11). Captured here so the plan phase inherits the decided scope
without re-litigating.

- **Q1 — Web-search fallback policy**: Rejected the premise. Tavily is a
  hard requirement; the fix must restore Tavily callability rather than
  design a fallback around its absence. This reframed the work from
  "tolerate MCP failure" to "fix the root cause so MCP does not fail".
  See FR-002.
- **Q2 — Health-signal shape**: Option A — fail the run (red X in the
  Actions UI). No separate "workflow-broken" issue. See FR-001 and SC-005.
- **Q3 — Prompt-runtime contract enforcement**: Option C plus a reframing.
  The `bun run check` command was NOT in the prompt; the agent improvised
  it. The fix is not to remove the instruction (it doesn't exist) but to
  add an explicit read-only scope to the prompt so the agent does not
  improvise build/validation commands in the first place. See FR-004.
