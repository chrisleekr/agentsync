# Phase 0 Research — Fix Feature Opportunity Researcher Workflow

**Feature**: `20260411-143905-fix-feature-researcher`
**Date**: 2026-04-11
**Status**: RESOLVED — R-1 decision = Option A (`copilot-cli` pinned to `v1.0.21` via `gh-aw v0.68.1` PR `#25689`; compiled into `.github/workflows/feature-research.lock.yml` at commit `ea312ad`). Post-compile validation run `24280821490` surfaced that Option A alone was **insufficient**: Copilot CLI 1.0.21 still hallucinated the `tavily` MCP tool as missing even though the gateway logged `✓ tavily: connected`. The follow-up fix (this branch's working-tree commit) therefore combines **three** changes: the v1.0.21 pin inherited from the compile, a full `tavily-mcp` removal in favour of `web-fetch` + `github` MCP (no third-party secret, no personal-account allowlist bug surface), and a strict-mode-compliant `sandbox:` block removal with `network.allowed` expanded to the vendor sites the prompt actually needs.

This document consolidates the evidence gathered for the plan phase. Every
claim is traceable to an upstream URL or a line in the failing run log
(`gh run view --job 70748164402 --log` on run `24232817769`). The spec’s
original root-cause attribution was **partially wrong** (see R-1 below) and
has been corrected here. The spec narrative will need a small amendment
during task phase to reflect the corrected attribution.

---

## R-1 — Copilot CLI silent-MCP-block regression

### Problem restated

On 2026-04-10 07:57 UTC, the agent job installed `GitHub Copilot CLI 1.0.22`
via `copilot-cli/releases/latest/download/copilot-linux-x64.tar.gz`. The
MCP gateway reported `✓ tavily: connected` (78 ms) at 07:57:35. Seventeen
seconds later the log shows
`! 3 MCP servers were blocked by policy: 'github', 'safeoutputs', 'tavily'`.
The agent could not emit any `create-issue` safe-output and the overall
run rolled up as `success` with zero output.

### Verified root cause (CORRECTED — differs from spec’s initial claim)

The spec initially attributed the failure to the personal-account
allowlist bug tracked in `github/copilot-cli#2479` and `#2481`. Fresh
evidence contradicts that attribution:

- **`github/copilot-cli#2479`** — **CLOSED as completed** on `2026-04-09T09:42:19Z`
  by `@JoannaaKL` (the assignee). Authoritative comment 2026-04-07:
  > “Please use the latest cli version ([1.0.19](https://github.com/github/copilot-cli/releases1.0.19)), this issue should be fixed.”

  Source: `https://github.com/github/copilot-cli/issues/2479#issuecomment-4197469208`
- **`github/copilot-cli#2481`** — CLOSED `2026-04-03T12:26:24Z` as a
  duplicate of `#2479`. Source:
  `https://github.com/github/copilot-cli/issues/2481`
- **`github/copilot-cli#2486`** — CLOSED `2026-04-07T18:39:34Z`. JoannaaKL
  told the reporter to use v1.0.20, and the reporter confirmed it worked.

So the **original allowlist bug was fixed before our failing run**. But
the failing run used v1.0.22. **`@sirbrettwaymouth` reported on #2486 at
2026-04-08T02:14:17Z**:

> “still getting this error using copilot cli on github hosted runner, using 1.0.21.”

Source: `https://github.com/github/copilot-cli/issues/2486#issuecomment-4203352380`
(3 👍 reactions). This indicates the MCP-block symptom **regressed in some
Copilot CLI releases after the #2479 fix** and was still observable at
least on 1.0.21 on GitHub-hosted runners.

The **authoritative confirmation** comes from the gh-aw framework itself.
`github/gh-aw` release `v0.68.1` (published `2026-04-10T19:52:21Z`, roughly
12 hours after our failing run) includes this line in its release notes:

> “**[Critical] Copilot CLI pinned to v1.0.21** — Fixes Copilot-engine
> workflows that were hanging indefinitely or producing **0-byte output**
> due to incompatibilities with v1.0.22. v1.0.21 is the last confirmed
> working version. ([#25689](https://github.com/github/gh-aw/pull/25689))”

Source: `https://github.com/github/gh-aw/releases/tag/v0.68.1`.

“0-byte output” is **exactly** our symptom — zero safe-output records with
a `success` run conclusion. The `! MCP servers blocked by policy` line we
observed is a manifestation of the v1.0.22 regression, not the original
`#2479` bug.

### Options considered for the AgentSync-side fix

| # | Option | Mechanism | Forward-compatible? | Requires local tool upgrade? |
|---|--------|-----------|---------------------|------------------------------|
| A | **Upgrade `gh aw` CLI to ≥v0.68.1 and recompile** | Inherits framework-level pin to Copilot CLI v1.0.21 automatically. No version hardcoded in our frontmatter. | Yes — upstream bumps the pin as they re-verify newer CLI versions. We benefit without further edits. | Yes — dev/maintainer must upgrade `gh aw` locally (currently on `v0.67.0`) to recompile the lock. |
| B | **Pin `engine.version: "1.0.21"` in our frontmatter** | Explicit, repo-visible version pin via the documented `engine.version` field. | Partial — remains pinned even if upstream invalidates 1.0.21. Manual bump required. | No. |
| C | **Set `engine.env.COPILOT_EXP_COPILOT_CLI_MCP_ALLOWLIST: "false"`** | Experimental feature-flag workaround from `#2486` body. | Uncertain — `COPILOT_EXP_*` is experimental. A future CLI release may ignore, remove, or invert the flag. Not referenced in gh-aw v0.68.1 release notes. | No. |
| D | **Combine A + B** (belt and suspenders) | Framework pin AND explicit engine.version pin. If the framework pin changes but the new version is bad for us, our local pin still protects the workflow. | Partial — extra maintenance. | Yes. |
| E | **Combine A + C** | Framework pin AND experimental env var flag. | Uncertain — relies on a flag that may be removed. | Yes. |

### Decision

Chosen option: `A` — inherits `github/gh-aw v0.68.1`'s framework-level pin of Copilot CLI to v1.0.21 (PR [`#25689`](https://github.com/github/gh-aw/pull/25689)); forward-compatible per FR-003 because the pin lives in the framework install script rather than repo-visible source; zero repo maintenance when upstream re-verifies a newer CLI and bumps the pin.

### Rationale considerations (for when you pick)

- **FR-003 forward-compatibility** pushes away from B and toward A.
- The fact that we’re currently on `gh aw v0.67.0` means A is NOT a
  zero-work option — the maintainer has to `gh extension upgrade gh-aw`
  locally before recompiling. That cost is one command.
- C (env-var) is the only option that can be added without upgrading
  anything, but the flag is experimental; the plan will need to document
  an auditing commitment to re-test annually or when Copilot CLI has a
  minor-version bump.
- D (A + B) is the most defensive posture but costs the most maintenance
  — you’d have to remember to bump both pins when the upstream framework
  bumps its pin.

### Alternatives rejected outright

- **Rewrite the workflow on a different engine (claude/codex/gemini).**
  Out of scope per spec “Out of Scope” section.
- **Patch `app.js` in the installed Copilot CLI cache** (as described in
  `#2486`). Not reproducible across runners and explicitly called out as
  “not a great long-term solution” by the commenter.
- **Downgrade to Copilot CLI 1.0.13** (per `#2479` comments). We can’t
  downgrade from `latest` in the gh-aw install script without engine.version
  anyway — and 1.0.13 predates other gh-aw-required capabilities.

---

## R-2 — gh-aw frontmatter fields that make this fix one file

Verified against
`https://github.com/github/gh-aw/blob/main/docs/src/content/docs/reference/frontmatter.md`
and `docs/src/content/docs/reference/engines.md` on commit
`4355d13ff75665c3f888805fe53e844c084c7f8d`.

### Decision — use only these four frontmatter fields

| Field | Source doc | Purpose in this fix |
|-------|-----------|---------------------|
| `engine.version` (string) | `engines.md` → “Pinning a Specific Engine Version” | Pin Copilot CLI version in-repo (Option B / D). Accepts either a literal (`"1.0.21"`) or a GHA expression. |
| `engine.env` (map) | `engines.md` → “Engine Environment Variables” + `environment-variables.md` → scope 4 (Engine) | Inject `COPILOT_EXP_COPILOT_CLI_MCP_ALLOWLIST` at the engine scope (Option C / E). Documented as a supported scope. |
| `post-steps:` (list) | `frontmatter.md` → “Post-Execution Steps” | Inject a deterministic assertion step into the agent job after agentic execution. Runs even on failure (`if: always()`). Runs OUTSIDE the firewall sandbox so it can `exit 1`. |
| `jobs:` (custom jobs) | `frontmatter.md` → “Custom Jobs” | Alternative to `post-steps:` — declare a standalone job with `needs: [agent]` that downloads the `agent` artifact and asserts on it. |

### Rationale

- `engine.version` is the cleanest way to express a version pin without
  editing gh-aw internals.
- `engine.env` is documented as scope 4 of 13 supported env-var scopes and
  is specifically highlighted in the engines doc with an example matching
  the shape we need (`DEBUG_MODE: "true"` etc.).
- `post-steps` runs inside the agent job and has direct access to
  `/tmp/gh-aw/agent_output.json`. This is the simplest place to enforce
  FR-001 because the agent job’s failure automatically makes the overall
  run conclusion `failure`.
- A custom `jobs:` block is more visible in the Actions UI but requires
  downloading the `agent` artifact and adds a second job. Less ergonomic
  for a single assertion.

### Alternatives considered

- **Edit the compiled `feature-research.lock.yml` directly** — rejected.
  The activation job has a “Check compile-agentic version” step that
  enforces hash consistency between `.md` frontmatter and
  `.lock.yml`; hand-edits are overwritten on the next compile.
- **Drop `safe-outputs.create-issue` and inject issue creation via a
  custom job** — rejected. Would require `issues: write` on a non-agent
  job, regressing the security posture guaranteed by safe-outputs.
- **Use a top-level `env:` block at workflow scope** — would work, but
  `engine.env` is the specific, documented scope for engine-runtime
  variables and is preferred per the 13-scope precedence table.

---

## R-3 — FR-001 (silent-success prevention) implementation

### Problem restated

FR-001 requires the workflow to end in conclusion `failure` when the agent
produces zero safe-output records. No built-in gh-aw frontmatter mechanism
exists for this.

### Evidence that no built-in exists

Fetched `docs/src/content/docs/reference/safe-outputs.md` (76 KB) on
commit `4355d13`. Searched for `min`, `minimum`, `required`,
`fail-on-empty`, `fail-if-empty`, `require-output`, `enforce`,
`strict-outputs`, `require-at-least-one`, `must-produce`,
`required-output-types`, `required_outputs`, `expected_outputs`. **None of
these fields exist.** The `noop` safe-output type exists but is a
best-practice prompt guideline, not an enforced runtime check — if the
agent omits `noop` AND all other safe-outputs, the run still rolls up as
`success`. The only failure-adjacent field is `report-failure-as-issue`,
which reports an _already failed_ run, it does not cause failure.

### Decision

Enforce FR-001 via a **deterministic `post-steps:` assertion injected into
the agent job**. The step:

1. Reads `/tmp/gh-aw/agent_output.json` (written by the existing “Write
   agent output placeholder if missing” step at lock.yml line 770).
2. Uses `jq` (pre-installed on `ubuntu-24.04`) to count
   `.items[] | select(.type == "create_issue")`.
3. If the count is zero, `echo`s an explicit failure message and `exit 1`.
4. `if: always()` so it runs even when the agent step crashed.

Failing the agent step makes `needs.agent.result == 'failure'`, which
causes the conclusion job to roll the overall run up as `failure` — red X
in the Actions UI, per SC-005.

### Rationale

- Deterministic — no agent cooperation required. Works even if the agent
  hallucinates a success message.
- Single source of truth — the agent’s own JSON output artifact.
- Constitution-compliant — does not add runtime TypeScript, tests, or
  schemas. Purely a workflow-file edit.
- Preserves the existing `noop` soft-signal: the `noop` type still counts
  as a safe-output record, so a legitimate “no gaps detected this week”
  path that emits `noop` passes the assertion.

### Alternative rejected: custom `jobs:` block

A standalone custom job with `needs: [agent]` would be more visible in
the Actions UI (named job tile) but costs:

- Extra artifact download.
- Duplicate `actions/checkout@SHA` + setup overhead.
- Second place to maintain the assertion logic.

The post-steps approach wins on simplicity; the custom job approach wins
on visibility. Chose simplicity.

### Alternative rejected: change the agent prompt to always self-report

“Make the agent always emit a create-issue even on error.” Unreliable:
when the agent’s tools are blocked (our exact symptom), the agent cannot
guarantee self-reporting. The assertion must run **outside** the agent.

---

## R-4 — FR-004 prompt scope discipline (`bun run check` improvisation)

### Problem restated

The 2026-04-10 agent log shows a step named *“Check repo status and run
baseline validation”* invoking `git --no-pager status --short && bun run
check`. The prompt file (verified by reading
`.github/workflows/feature-research.md:41-99`) does NOT mention `bun run
check` or any validation command. The agent improvised this step — and
the runner does not have Bun installed, so it failed and the agent burned
continuation budget reasoning about the failure.

### Decision

Add an explicit **“Read-only scope”** section to the markdown body of
`.github/workflows/feature-research.md`, placed immediately after the
existing “## Important” block. The section must:

1. Declare the research task is read-only against the working tree.
2. Prohibit running repo build/test/validation commands (`bun run check`,
   `bun install`, `npm test`, `git add`, `git commit`, etc.).
3. Explain *why* (GitHub-hosted runner has no Bun; validation is not the
   research job’s concern).

The exact wording is left to the task phase (no ambiguity in the plan).

### Rationale

- Matches FR-004 literal requirement.
- The fix is purely prompt text — zero runtime or workflow-schema
  changes. Fully within the docs-only constitutional exception.
- Doesn’t over-prescribe: we tell the agent what’s out of scope without
  enumerating every possible forbidden command.

### Alternative rejected: remove the Bun check entirely from the agent job

Out of scope. The agent job’s `bun run check` wasn’t invoked by the
workflow file — the agent invented it. Removing Bun from the runner
environment wouldn’t help because the runner doesn’t have Bun to begin
with; the command failed last time, it will fail again, and the fix is
to stop the agent from trying.

---

## R-5 — Compile command for regenerating the lock file

### Decision

- **CLI**: `gh extension install github/gh-aw` (already installed locally
  per `gh extension list`).
- **Local version** (verified by running `gh aw version`): **`v0.67.0`**.
  *This is the same version that produced the buggy lock file on
  2026-04-10.* It must be upgraded to `≥v0.68.1` if Option A or D is
  chosen in R-1.
- **Upgrade**: `gh extension upgrade gh-aw`
- **Compile**: `gh aw compile feature-research` (working directory = repo
  root). Verified from `docs/src/content/docs/setup/cli.md` via WebFetch.
- **Strict mode flag**: `gh aw compile feature-research --strict`. The
  feature-research workflow is for a **public repository**, so strict
  mode is effectively mandatory — the frontmatter lacks `strict: false`
  and the doc warns “Workflows compiled with `strict: false` cannot run
  on public repositories.”

### Rationale

- `gh aw compile` is the only supported, hash-consistent way to
  regenerate `feature-research.lock.yml`. Hand-editing the lock file is
  blocked by the activation-job hash check.
- Local upgrade is cheap (one command, no repo state).

### Alternative rejected: let CI recompile

Out of scope — there is no CI job that runs `gh aw compile` in this
repo. The maintainer recompiles locally and commits both files together.

---

## R-6 — Latest versions reference table

Captured for task-phase version-bump references. Verified via
`mcp__github__get_latest_release` on 2026-04-11.

| Repo | Current local/run | Latest stable | Published | Relevance |
|------|-------------------|---------------|-----------|-----------|
| `github/copilot-cli` | `1.0.22` (installed on 2026-04-10 run) | `v1.0.24` | `2026-04-10T23:30:25Z` | `v1.0.21` is the gh-aw-confirmed-working version; `v1.0.22` is the known-broken one; `v1.0.23`/`v1.0.24` not yet verified by the gh-aw team in release notes. |
| `github/gh-aw` | `v0.67.0` (local) / `v0.67.0` (in failing lock.yml) | `v0.68.1` | `2026-04-10T19:52:21Z` | `v0.68.1` is the release that pins Copilot CLI to 1.0.21 via PR #25689. |

---

## Open questions — none

All four NEEDS CLARIFICATION items from spec-review are resolved. The
R-1 Decision was taken as **Option A**: pin `copilot-cli` to `v1.0.21` by
inheriting `gh-aw v0.68.1` (PR `#25689`, "0-byte output" root cause).
The pin is compiled into `.github/workflows/feature-research.lock.yml`
at commit `ea312ad`.

**Post-compile follow-up (added after T025 validation run `24280821490`)**:
the Option A pin fixes the 0-byte output failure mode but does NOT fix
Copilot CLI 1.0.21's separate regression where a working, connected
`tavily` MCP server is hallucinated as a missing tool. Rather than wait
for a downstream CLI fix, this branch removes the `tavily-mcp` dependency
entirely and substitutes `web-fetch` (built-in, zero-secret) plus the
`github` MCP `repos` toolset for structured release data. That change
also removes the `TAVILY_API_KEY` secret surface and narrows the
`network.allowed` egress list to the specific vendor sites the prompt
needs. The original `sandbox.agent: false` escape hatch that went along
with Tavily removal is **also** gone — strict-mode compilation
(`gh aw compile --strict`) forbids it, and the curated allowlist plus
the `github` MCP cover the same research surface without bypassing the
AWF firewall.

---

## References

1. `https://github.com/github/copilot-cli/issues/2479` — allowlist bug,
   CLOSED 2026-04-09, fixed in v1.0.19.
2. `https://github.com/github/copilot-cli/issues/2481` — CLOSED
   2026-04-03, duplicate of #2479.
3. `https://github.com/github/copilot-cli/issues/2486` — CLOSED
   2026-04-07; comment 2026-04-08 shows v1.0.21 still problematic on
   hosted runners.
4. `https://github.com/github/gh-aw/releases/tag/v0.68.1` — framework
   release pinning Copilot CLI to 1.0.21 with explicit “0-byte output”
   root cause.
5. `https://github.com/github/gh-aw/pull/25689` — the PR that implemented
   the pin.
6. `https://github.com/github/gh-aw/blob/main/docs/src/content/docs/reference/frontmatter.md`
   — `post-steps:`, `jobs:`, env scopes.
7. `https://github.com/github/gh-aw/blob/main/docs/src/content/docs/reference/engines.md`
   — `engine.version`, `engine.env`.
8. `https://github.com/github/gh-aw/blob/main/docs/src/content/docs/reference/environment-variables.md`
   — 13-scope env precedence.
9. `https://github.com/github/gh-aw/blob/main/docs/src/content/docs/reference/safe-outputs.md`
   — confirms no built-in fail-on-empty.
10. Local failing run log: `gh run view --job 70748164402 --log` on run
    `24232817769`.
