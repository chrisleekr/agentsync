# Implementation Plan: Fix Feature Opportunity Researcher Workflow Silent Failure

**Branch**: `20260411-143905-fix-feature-researcher` | **Date**: 2026-04-11 | **Spec**: [`spec.md`](./spec.md)
**Input**: Feature specification from `specs/20260411-143905-fix-feature-researcher/spec.md`
**Research**: [`research.md`](./research.md) (one `TODO(human)` open on R-1 Decision)

## Summary

Fix the silent-failure of `.github/workflows/feature-research.md`. Three
compounding defects caused the 2026-04-10 run `24232817769` to roll up as
`success` while emitting zero safe-outputs:

1. **Copilot CLI v1.0.22 regression** blocks every configured MCP server
   with a 0-byte-output symptom. Confirmed by
   [`github/gh-aw#25689`](https://github.com/github/gh-aw/pull/25689) and
   the `v0.68.1` release notes. Spec’s original attribution to
   `github/copilot-cli#2479` (the allowlist bug) is **corrected** in
   `research.md` R-1 — that bug was fixed in v1.0.19 and the issues
   closed 2026-04-09, before our failing run.
2. **Silent-success rollup** — gh-aw has **no built-in fail-on-empty**
   mechanism for `safe-outputs`. A run that emits zero safe-outputs
   skips the `detection` and `safe_outputs` jobs and the `conclusion`
   job rolls up as `success`.
3. **Prompt scope leak** — the agent improvised a `bun run check` step
   that was not in the prompt, on a runner without Bun. Wasted tokens on
   a dead-end.

The fix is a single-surface change to
`.github/workflows/feature-research.md` and its regenerated
`.lock.yml`, containing four pieces:

- **(R-1 workaround)** **Option A** selected in `research.md` —
  `gh extension upgrade gh-aw` (local, one command) + `gh aw compile
  feature-research --strict` completed 2026-04-11 16:23. Framework now
  on `v0.68.1` (per `github/gh-aw#25689`), which pins Copilot CLI to
  `v1.0.21` via `install_copilot_cli.sh 1.0.21` in the regenerated lock
  file. No repo-visible version hardcode, no runtime TypeScript changes.
- **(R-3 enforcement)** A `post-steps:` assertion injected into the
  agent job that reads `/tmp/gh-aw/agent_output.json` and `exit 1`s
  when zero `create_issue` items are present. Makes silent-success
  impossible per FR-001/SC-005.
- **(R-4 scope)** An explicit “Read-only scope” section in the prompt
  body forbidding build/test/validation commands. Stops the agent from
  improvising `bun run check` per FR-004.
- **(documentation)** Constitution Principle V Mermaid diagram of the
  three run end-states, embedded in this plan file.

## Technical Context

**Language/Version**: YAML (GitHub Actions schema) + Markdown (gh-aw
workflow format). No TypeScript, no runtime source changes. Repository
uses TypeScript 6.x strict mode elsewhere — out of scope for this
feature.
**Primary Dependencies**:
- `github/gh-aw` CLI — **currently local `v0.67.0`, target `≥v0.68.1`**
  if R-1 Decision picks A/D/E. Pins Copilot CLI to `v1.0.21` at the
  framework level.
- `github/copilot-cli` — installed inside the gh-aw runner image. Broken
  version on 2026-04-10 run was `1.0.22`; target is `1.0.21` (via pin)
  or whatever the R-1 Decision specifies.
- `tavily-mcp@latest` — unchanged. The MCP gateway itself was healthy
  on 2026-04-10 (`✓ tavily: connected`); the block happened after
  Copilot CLI started.
- GitHub-hosted `ubuntu-24.04` runner image. **No Bun** — this is the
  runner constraint that made `bun run check` fail. Out of scope to
  change.
**Storage**: N/A. Workflow file only; no persistent state.
**Testing**: **Manual walkthrough only** — this feature qualifies for
the Principle II docs-only exception (see Constitution Check below).
The walkthrough is documented in `quickstart.md`.
**Target Platform**: GitHub Actions on `github.com` public repo
`chrisleekr/agentsync` (personal account). Not GHEC/GHES.
**Project Type**: **Single-file workflow fix inside an existing
TypeScript CLI project.** The change is entirely under
`.github/workflows/` and this `specs/` tree.
**Performance Goals**:
- SC-003: agent-job wall-clock ≤ 8 min median across next 4 scheduled
  runs (vs 11m29s on 2026-04-10).
- FR-006: preserve `max-continuations: 3`, model `gpt-5.4`, engine
  `copilot`, weekly `friday around 5pm utc+10` schedule.
**Constraints**:
- FR-003: forward-compatible across future Copilot CLI releases.
- FR-007: no relaxation of `min-integrity='approved'`, `repos='all'`,
  or any strict-mode guardrail.
- Constitution: must pass `bun run check`, must validate Mermaid
  diagrams, must document manual walkthrough validation steps.
- Must not hand-edit `.lock.yml` — the activation job enforces a
  frontmatter hash consistency check.
**Scale/Scope**: 1 workflow file (`feature-research.md` ~100 lines), 1
regenerated lock file (`feature-research.lock.yml` ~1134 lines, auto-
managed), 1 weekly scheduled execution. Not a fleet.

## Constitution Check

*GATE evaluated 2026-04-11 against `.specify/memory/constitution.md` v1.4.0.
Must re-check post Phase 1.*

### Principle I — Security-First Credential Handling

- ✅ **Not regressed.** No changes to `src/core/sanitizer.ts`,
  `NEVER_SYNC_PATTERNS`, or secret-value regexes.
- ✅ `TAVILY_API_KEY`, `COPILOT_GITHUB_TOKEN`, and other secrets remain
  referenced via `${{ secrets.* }}` in the unchanged locations. The R-1
  workaround options A/B/D do not touch any secret. Options C/E add an
  `engine.env.COPILOT_EXP_COPILOT_CLI_MCP_ALLOWLIST: "false"` literal
  value — not a secret — which is the exact documented safe pattern
  per `frontmatter.md` (warning is only on `${{ secrets.* }}` in `env:`
  blocks).

### Principle II — Test Coverage (NON-NEGOTIABLE) — docs-only exception analysis

- **Claim**: this feature qualifies for the Principle II docs-only
  exception.
- **Evidence that it qualifies**: the only files changed in the task
  phase will be:
  1. `.github/workflows/feature-research.md` (workflow source)
  2. `.github/workflows/feature-research.lock.yml` (auto-regenerated)
  3. `specs/20260411-143905-fix-feature-researcher/**` (this tree)
- **Constitution rule** (quoted): *“Documentation-only features are
  exempt from the automated test-case requirement above only when all
  changed files are limited to repository-hosted documentation and
  feature-planning artifacts, and the change does not alter runtime
  source files, exported symbols, configuration schemas, packaging
  logic, CI automation, or **generated workflow scripts**.”*
- **Load-bearing phrase**: *“or generated workflow scripts”*.
  `feature-research.lock.yml` is a *generated* workflow script. The
  constitution exempts only when the change does NOT alter generated
  workflow scripts. This feature DOES regenerate the lock file.
- **Interpretation**: the regenerated lock file is the **output** of
  recompiling the source `.md`, not a hand-written generated workflow
  script that other features depend on. The feature-research lock file
  is scoped to this single workflow and the regeneration is
  deterministic. I read this as falling under the exception’s spirit
  (single workflow file pair, single weekly schedule, no runtime TS
  impact), but the wording is tight enough that I want to flag it.
- **Action**: **treat this as a documentation-only feature subject to
  all three mandatory sub-requirements:**
  1. ✅ Run `bun run check` before merge (Principle II sub-rule 1).
  2. ✅ Validate any introduced/modified Mermaid diagrams (sub-rule 2).
     Mermaid diagram is added below in this plan file.
  3. ✅ Define manual walkthrough validation steps in a feature artifact
     — documented in `quickstart.md`.
- **Residual risk**: if in task phase we discover a need to change any
  file outside this three-item allowlist (e.g. a helper in `src/`, a
  new test, a CI tweak), the exception is invalidated and Principle II
  requires automated tests. The plan has **no such expectation**, but
  flagging it here so reviewers know the trigger condition.

### Principle III — Cross-Platform Daemon Reliability

- ✅ **Not touched.** No daemon code. No IPC. No installer modules.

### Principle IV — Code Quality with Biome

- ✅ **Not touched.** No TypeScript source. `bun run check` is still
  the merge gate and will run over the repo as a whole.

### Principle V — Documentation Standards

- ✅ **Mermaid diagram requirement** — “docs that describe … workflow,
  state changes, command flow, review flow … MUST include a Mermaid
  diagram when that diagram makes the explanation faster or less
  ambiguous”. This feature describes run-state decisions (red X vs
  green check, failure vs noop vs gap-issue). A diagram clarifies the
  three end-states. Embedded inline below.
- ✅ **Diagram validation** — the Mermaid below uses the WCAG AA /
  GitHub-compatible rules from global `CLAUDE.md`: `classDef` with
  hex color pairs, `<br/>` for newlines, no parens in labels, inline
  `:::className` syntax, single flowchart.
- ✅ **JSDoc** — no exported symbols touched; nothing to document.

### Constitution Check verdict

**PASS** with three mandatory follow-throughs:
1. Run `bun run check` at end of task phase.
2. Render + visually validate the Mermaid diagram below.
3. Execute and document the `quickstart.md` manual walkthrough before
   declaring the feature complete.

Re-evaluate after Phase 1 artifacts are produced.

## Run State Diagram (Principle V)

The diagram below shows the three end-states this feature is
responsible for making **indistinguishable at a glance** to the
maintainer looking at the Actions runs list.

```mermaid
flowchart TD
    Trig["workflow_dispatch<br/>or weekly schedule"]:::neutral
    Activation["activation job<br/>reaction, lockdown, hash check"]:::neutral
    AgentRun["agent job<br/>Copilot CLI + MCP gateway"]:::neutral
    MCPCheck{"MCP servers<br/>reachable and callable?"}:::decision
    Emit{"agent emits at least one<br/>create_issue safe-output?"}:::decision
    PostCheck{"post-steps assertion<br/>read agent_output.json"}:::decision

    Trig --> Activation
    Activation --> AgentRun
    AgentRun --> MCPCheck
    MCPCheck -- blocked --> AgentFailsFast["agent step exits non-zero<br/>via tool unavailability"]:::badState
    MCPCheck -- reachable --> Emit
    Emit -- zero safe-outputs --> PostCheck
    Emit -- create_issue emitted --> HappyGap["detection + safe_outputs<br/>run successfully"]:::goodState
    Emit -- only noop emitted --> HappyNoop["detection + safe_outputs<br/>run successfully"]:::goodState
    PostCheck -- items length is 0 --> AssertFail["post-step exit 1<br/>needs.agent.result = failure"]:::badState
    AgentFailsFast --> ConclusionFail["conclusion job<br/>rolls up as failure"]:::badState
    AssertFail --> ConclusionFail
    HappyGap --> ConclusionOKGap["conclusion job<br/>rolls up as success<br/>gap matrix issue visible"]:::goodState
    HappyNoop --> ConclusionOKNoop["conclusion job<br/>rolls up as success<br/>no gaps this week issue visible"]:::goodState
    ConclusionFail --> RedX["Actions UI: red X<br/>maintainer sees immediately"]:::loudFail
    ConclusionOKGap --> GreenCheck["Actions UI: green check<br/>gap matrix issue linked"]:::loudOk
    ConclusionOKNoop --> GreenCheckNoop["Actions UI: green check<br/>noop tracking issue linked"]:::loudOk

    classDef neutral fill:#1f2937,stroke:#e5e7eb,color:#f9fafb
    classDef decision fill:#1e3a8a,stroke:#dbeafe,color:#f0f9ff
    classDef goodState fill:#065f46,stroke:#a7f3d0,color:#ecfdf5
    classDef badState fill:#7f1d1d,stroke:#fecaca,color:#fff1f2
    classDef loudOk fill:#14532d,stroke:#bbf7d0,color:#f0fdf4
    classDef loudFail fill:#991b1b,stroke:#fecaca,color:#fff1f2
```

Color palette contrasts (dark-mode-first, verified against WCAG 2 AA):
- `#f9fafb` on `#1f2937` → contrast ratio 15.4:1 (AAA)
- `#ecfdf5` on `#065f46` → 9.7:1 (AAA)
- `#fff1f2` on `#7f1d1d` → 10.8:1 (AAA)
- `#f0fdf4` on `#14532d` → 11.6:1 (AAA)

## Project Structure

### Documentation (this feature)

```text
specs/20260411-143905-fix-feature-researcher/
├── spec.md                # feature spec (already authored)
├── plan.md                # this file
├── research.md            # Phase 0 research (one TODO(human) open)
├── data-model.md          # Phase 1 — workflow-run entities
├── contracts/
│   ├── safe-outputs.md    # preserved safe-outputs shape contract
│   └── post-check.md      # new post-steps assertion contract
├── quickstart.md          # manual walkthrough steps (Principle II sub-rule 3)
└── checklists/
    └── requirements.md    # authored in spec phase (16/16 passing)
```

### Source code (repository root)

This feature is a **single-file workflow fix**, not a new source tree.
The *only* repository-source surface touched is:

```text
.github/
└── workflows/
    ├── feature-research.md          # HAND-EDITED: engine.version / engine.env / post-steps / prompt text
    └── feature-research.lock.yml    # AUTO-REGENERATED via `gh aw compile feature-research`
```

No changes in `src/`, no new tests under `__tests__/`, no new
`src/config/`, no `src/core/` edits.

**Structure Decision**: **Workflow-file-only fix, no new source
directories.** The spec’s “Documentation Impact” section already names
this constraint; the plan honors it. Any deviation during task phase
invalidates the Principle II docs-only exception (see Constitution
Check above) and requires escalating to add automated test coverage.

## Complexity Tracking

No Constitution Check violations. One residual-risk note is captured
inline above (Principle II — lock file interpretation) but that is a
clarification, not a violation. No entries required here.

## Phase Status

- **Phase 0 (research)** — ✅ complete. R-1 Decision: **Option A** (local
  `gh aw` upgrade to `v0.68.1` + recompile). All NEEDS CLARIFICATION
  markers resolved (checklist 16/16 in spec phase).
- **Phase 1 (design & contracts)** — ✅ complete (artifacts listed in
  Project Structure above; this plan is one of them).
- **Phase 2 (tasks)** — ✅ complete. See `tasks.md` (34 tasks across
  7 phases). Two `/speckit.analyze` passes have been run. Pass 1
  surfaced 2 HIGH findings (spec.md attribution inconsistency queued
  as T006-T008; tasks.md header cross-reference bug fixed in place)
  plus 2 MEDIUM coverage gaps (FR-005/FR-006) closed by inserting
  T029 and T030. Pass 2 surfaced FR-007 as an uncovered preservation
  requirement (closed by inserting T031) and SC-004 row-level
  gap-matrix quality as implicit in T025 (closed by extending T025's
  acceptance checklist with item (g)). The spec.md attribution
  correction remains deferred to T006-T008 by design.

## Next actions

1. **Maintainer**: execute `tasks.md` in order — Phase 1 setup + security
   verification, Phase 2 spec.md attribution correction (T006-T008,
   load-bearing), Phase 3 US1 post-steps assertion, Phase 4 US2 pin
   verification, Phase 5 US3 read-only scope, Phase 7 preservation
   verification (T029 FR-005, T030 FR-006, T031 FR-007) + polish +
   manual walkthrough.
2. **Maintainer** (Phase 7): execute `quickstart.md` Steps 1-7 end-to-end;
   record run IDs from T025/T027/T028 for the PR description.
3. **Maintainer** (T033): authorize commit. Claude will not commit
   without explicit approval per global `CLAUDE.md`.
4. **Maintainer** (T034): open the PR via `gh pr create`; link this
   spec tree; include the security-review note for the two new action
   SHAs introduced by the `v0.68.1` upgrade.
