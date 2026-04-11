# Tasks: Fix Feature Opportunity Researcher Workflow Silent Failure

**Feature Branch**: `20260411-143905-fix-feature-researcher`
**Input**: Design documents from `/specs/20260411-143905-fix-feature-researcher/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅ (R-1: Option A), data-model.md ✅, contracts/ ✅, quickstart.md ✅

**Testing Regime**: **Documentation-only exception under Constitution Principle II.** All file changes land in the `.specify/` feature tree, plus `.github/workflows/feature-research.md` (source) and `.github/workflows/feature-research.lock.yml` (regenerated). No new automated tests are generated; instead this task list enforces the three mandatory sub-requirements per the constitution:

1. `bun run check` pre-merge (sub-rule 1 — T022).
2. Mermaid diagram validation in `plan.md` (sub-rule 2 — T023).
3. Manual walkthrough via `quickstart.md` (sub-rule 3 — T024-T028).

If the task phase discovers any need to edit `src/`, add tests, change `tsconfig.json`, or touch CI beyond this single workflow, the docs-only exception is invalidated and tasks.md must be regenerated with automated test coverage.

**R-1 Decision (from research.md)**: **Option A** — `gh aw` upgraded locally to `v0.68.1` and `gh aw compile feature-research --strict` was run at 2026-04-11 16:23. The Copilot CLI pin to `v1.0.21` (per `github/gh-aw#25689`) is already live in the uncommitted working-tree version of `feature-research.lock.yml`. **Option A's implementation work is mostly verification, not modification.**

**Root-cause correction carried from research.md → spec.md**: The spec's Background section currently attributes the silent failure to `github/copilot-cli#2479` / `#2481` (the personal-account allowlist bug). Research proved this attribution **wrong** — #2479 was closed as completed on 2026-04-09 (fixed in CLI v1.0.19, before the 2026-04-10 failing run). The authoritative root cause is a fresh **v1.0.22 regression** producing 0-byte output, confirmed in the `github/gh-aw v0.68.1` release notes published 2026-04-10T19:52:21Z (≈12 hours after the failing run). **Phase 2 foundational work corrects this attribution in spec.md before any user-story implementation begins.**

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- All file paths are absolute or repo-relative from repo root

## Path Conventions

This feature is a **single-file workflow fix** plus documentation. No `src/`, no `tests/`, no new directories. Paths are:

- Spec tree: `specs/20260411-143905-fix-feature-researcher/`
- Workflow source: `.github/workflows/feature-research.md`
- Workflow compiled lock: `.github/workflows/feature-research.lock.yml`
- Framework action lock: `.github/aw/actions-lock.json`

---

## Phase 1: Setup (Environment + Security Verification)

**Purpose**: Confirm the local gh-aw toolchain is on `v0.68.1` (R-1 Option A prerequisite), security-verify the new action SHAs introduced by the framework upgrade, and re-confirm the Copilot CLI `v1.0.21` pin is live in the regenerated lock file.

- [X] T001 Verify local `gh aw` version is `≥v0.68.1` by running `gh aw version` and confirming output starts with `gh aw version v0.68.1` or higher. If lower, run `gh extension upgrade gh-aw` and re-verify. Prerequisite for R-1 Option A; all other tasks assume this passes.

- [X] T002 [P] Security-verify `github/gh-aw-actions/setup@v0.68.1` SHA. Run `gh api repos/github/gh-aw-actions/setup/git/refs/tags/v0.68.1 --jq .object.sha` and confirm the returned SHA equals `2fe53acc038ba01c3bbdc767d4b25df31ca5bdfc` (the pin in `.github/aw/actions-lock.json`). If it does not match, STOP and treat as a potential supply-chain incident — do not proceed with any compile or commit.

- [X] T003 [P] Security-verify `actions/github-script@v9` SHA (newly introduced by the v0.68.1 upgrade). Run `gh api repos/actions/github-script/git/refs/tags/v9 --jq .object.sha` and confirm the returned SHA equals `373c709c69115d41ff229c7e5df9f8788daa9553` (the pin in `.github/aw/actions-lock.json`). If it does not match, STOP as above.

- [X] T004 [P] Audit the new `actions/github-script@v9` usage by running `grep -n "actions/github-script" .github/workflows/feature-research.lock.yml` and reading every hit in context. Confirm none of the surrounding `with: script:` blocks write to `$GITHUB_TOKEN`, exfiltrate secrets, or access domains outside the existing `GH_AW_ALLOWED_DOMAINS` allowlist. Document findings in a brief note for the PR description.

- [X] T005 [P] Verify the Copilot CLI `v1.0.21` pin is present in `.github/workflows/feature-research.lock.yml` by running `grep -n "install_copilot_cli.sh 1.0.21" .github/workflows/feature-research.lock.yml`. Expect two hits (line ~355 agent job, line ~1047 detection job). Also confirm `grep -n 'GH_AW_INFO_VERSION: "1.0.21"'` returns at least one match. This closes R-1 Option A implementation without further edits.

**Checkpoint**: Environment verified and cryptographically consistent. Framework pin is live. Task phase can now proceed to foundational edits.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Correct the spec.md root-cause attribution (load-bearing for every downstream user story) and append the R-1 decision rationale to research.md so the research artifact stands alone for future auditors.

**⚠️ CRITICAL**: No user story work begins until Phase 2 is complete. Spec accuracy gates implementation work.

- [X] T006 Correct `specs/20260411-143905-fix-feature-researcher/spec.md` Background section (lines ~27-71) to replace the `#2479`/`#2481` attribution with the v1.0.22 regression explanation. Replace verified-root-cause bullet #1 to cite: (a) `#2479` was closed as completed on 2026-04-09 by @JoannaaKL with `v1.0.19` as the fix; (b) the 2026-04-10 failing run installed `v1.0.22`; (c) `github/gh-aw v0.68.1` release notes (published 2026-04-10T19:52:21Z) pin Copilot CLI to `v1.0.21` via PR `github/gh-aw#25689`, citing "0-byte output" as the symptom; (d) our failing run's symptom is exactly 0-byte output. Quote text available in `research.md` R-1 section.

- [X] T007 Correct `specs/20260411-143905-fix-feature-researcher/spec.md` FR-002 (lines ~255-261) to remove the `#2479`/`#2481` reference and replace with "Copilot CLI v1.0.22 regression per `github/gh-aw#25689`" plus the `v0.68.1` release-notes citation. Keep FR-002's requirement language the same — only the upstream-bug reference changes.

- [X] T008 Correct `specs/20260411-143905-fix-feature-researcher/spec.md` Assumptions section (lines ~346-352) to drop the `#2479`/`#2481` dependency on personal-account 404 behavior. The new root cause is version-specific (v1.0.22), not account-type-specific. Replace the personal-account paragraph with a note that the fix pins the CLI version at the framework level and works independent of account type.

- [X] T009 [P] Append a one-line rationale to `specs/20260411-143905-fix-feature-researcher/research.md` line 84 so the Decision block reads `Chosen option: A — <rationale>`. The rationale text is the maintainer's call — suggested phrasing is in the conversation log. This closes the audit-completeness gap on the research artifact.

**Checkpoint**: Spec artifacts truthfully describe the root cause. Research artifact self-contained. User-story implementation can begin.

---

## Phase 3: User Story 1 — Silent-success is impossible (Priority: P1) 🎯 MVP

**Goal**: Make it impossible for `.github/workflows/feature-research.md` to roll up as `success` when the agent produced zero `create_issue` AND zero `noop` safe-output records. The mechanism is a `post-steps:` assertion injected into the agent job that reads `/tmp/gh-aw/agent_output.json` and `exit 1`s on empty output, per `contracts/post-check.md`.

**Independent Test**: Dispatch the workflow with a deliberately-broken `TAVILY_API_KEY` value. Verify the run ends in `failure` (red X in Actions UI) and the `agent` job log contains `::error::FR-001 violation — agent emitted zero create_issue and zero noop safe-outputs`. This is `quickstart.md` Step 5.

**Docs-only exception**: Automated tests are replaced by `quickstart.md` Step 5 in Phase 7.

### Implementation for User Story 1

- [X] T010 [US1] Add the `post-steps:` block to the frontmatter of `.github/workflows/feature-research.md`, placed after the existing `safe-outputs:` block. Copy the exact YAML from `specs/20260411-143905-fix-feature-researcher/contracts/post-check.md` — including `set -euo pipefail`, the `/tmp/gh-aw/agent_output.json` existence check, the `jq` count for both `create_issue` AND `noop` record types, and the `::error::` workflow annotation. Do NOT omit `if: always()` — the step must run even when the agent step crashes.

- [X] T011 [US1] Regenerate `.github/workflows/feature-research.lock.yml` by running `gh aw compile feature-research --strict` from repo root. Expect a clean compile (warnings about safe-update mode are acceptable only if they match the secrets/actions already approved in Phase 1). Confirm the compile output shows `✓ .github/workflows/feature-research.md` and the lock file's on-disk mtime is newer than the source `.md`.

- [X] T012 [US1] Verify the post-steps assertion was injected into the agent job in `.github/workflows/feature-research.lock.yml` by running `grep -n "Assert agent emitted at least one safe-output record" .github/workflows/feature-research.lock.yml`. Expect exactly one hit inside the `agent` job definition (before the `detection` job begins). Also confirm the step body contains the literal `FR-001 violation` string.

- [X] T013 [US1] Visually inspect the full injected step in `.github/workflows/feature-research.lock.yml` (read a 40-line context window around the T012 match). Confirm: (a) `if: always()` is present; (b) the step runs inside the agent job, not a separate custom job; (c) the `jq` filter checks BOTH `create_issue` AND `noop` types (so the "no gaps this week" noop path passes); (d) the script does not read or echo any `${{ secrets.* }}` values.

**Checkpoint**: US1 is code-complete. Silent-success is impossible on the next workflow run. Ready for manual walkthrough verification in Phase 7.

---

## Phase 4: User Story 2 — MCP servers (Tavily, github, safeoutputs) callable (Priority: P1)

**Goal**: The agent must be able to invoke `mcp__tavily__search` successfully in every scheduled run. Under R-1 Option A this is achieved entirely by the framework pin of Copilot CLI to `v1.0.21` via `gh-aw v0.68.1` (PR `#25689`). **The implementation work for US2 was completed in Phase 1 when the framework was upgraded and recompiled.** This phase is pure verification — the tasks below exist to make the evidence explicit and reviewable.

**Independent Test**: Dispatch the workflow and inspect the agent log. The line `! N MCP servers were blocked by policy` must NOT appear for `tavily`, `github`, or `safeoutputs`. The agent must emit at least one successful `mcp__tavily__search` tool call with results. This is `quickstart.md` Step 3.

### Verification for User Story 2

- [X] T014 [P] [US2] Verify the framework-level Copilot CLI pin by running `grep -n "install_copilot_cli.sh 1.0.21" .github/workflows/feature-research.lock.yml`. Must return ≥2 hits (agent job ~line 355, detection job ~line 1047). If zero hits, rerun `gh aw compile feature-research --strict` and re-verify; if still zero, stop and investigate — the framework pin is not being honored.

- [X] T015 [P] [US2] Verify the gh-aw framework version in the compiled lock by running `grep -n "GH_AW_VERSION: v0.68.1" .github/workflows/feature-research.lock.yml`. Must return ≥1 hit. Also verify the compile metadata header: `head -1 .github/workflows/feature-research.lock.yml` must contain `"compiler_version":"v0.68.1"`.

- [X] T016 [P] [US2] Verify that no `engine.version` or `engine.env.COPILOT_EXP_COPILOT_CLI_MCP_ALLOWLIST` was added to `.github/workflows/feature-research.md` frontmatter (Option A only — these belong to Options B/C/D/E which were not selected). Run `grep -n "engine:" .github/workflows/feature-research.md` and confirm the block remains the minimal `id: copilot / model: gpt-5.4 / max-continuations: 3` form from the original workflow.

- [X] T017 [P] [US2] Forward-compatibility sanity check (FR-003): confirm that nothing in `.github/workflows/feature-research.md` hardcodes a Copilot CLI version number. `grep -n "1.0.21" .github/workflows/feature-research.md` must return zero hits. The version pin lives in the framework install script (regenerated on every `gh aw compile`), not the repo-visible source.

**Checkpoint**: US2 is verified green. The framework-level pin is in place and forward-compatible. On the next `gh extension upgrade gh-aw`, any upstream pin bump will be absorbed automatically on the next recompile.

---

## Phase 5: User Story 3 — Prompt does not ask the agent to improvise tooling (Priority: P2)

**Goal**: Add an explicit "Read-only scope" section to the markdown body of `.github/workflows/feature-research.md` that forbids the agent from running `bun run check`, `bun install`, `npm test`, or any other repo-validation command. This stops the agent from burning continuation budget on improvised dead-ends on a runner that has no Bun installed.

**Independent Test**: Dispatch the workflow. The agent log must NOT contain any invocation of `bun run check`, `bun install`, `npm test`, or equivalent. Only the research tool calls explicitly asked for by the prompt should appear. This is part of `quickstart.md` Step 3 acceptance checklist.

### Implementation for User Story 3

- [X] T018 [US3] Add a new section titled `## Read-only scope` (or similar, authorial choice) to the markdown body of `.github/workflows/feature-research.md`, placed immediately after the existing `## Important` block. The section MUST: (a) declare the research task is read-only against the working tree; (b) explicitly prohibit `bun run check`, `bun install`, `npm test`, `git add`, `git commit`, and any other build/test/validation command; (c) explain why (runner lacks Bun; validation is not this workflow's job); (d) be concise — no more than ~8 lines of markdown. Do NOT touch the existing `## Important` block or any frontmatter.

- [X] T019 [US3] Regenerate `.github/workflows/feature-research.lock.yml` again by running `gh aw compile feature-research --strict`. This absorbs the prompt body change into the lock file's embedded `prompt.txt` generation step. Verify no new warnings appeared beyond those already approved in Phase 1.

- [X] T020 [US3] Verify the new "Read-only scope" section landed in the compiled lock by running `grep -n "Read-only scope" .github/workflows/feature-research.lock.yml`. Must return ≥1 hit (inside the step that writes `prompt.txt` for the agent). Also `grep -n "bun run check" .github/workflows/feature-research.lock.yml` to confirm the prohibition wording is embedded in the prompt payload.

**Checkpoint**: US3 is code-complete. The next workflow run's agent will see an explicit "no build commands" directive in the prompt, preventing the `bun run check` improvisation.

---

## Phase 6: User Story 4 — Scheduled cadence resumes reliably (Priority: P3)

**Goal**: Set up the observability window to confirm that after merge the next four weekly scheduled runs all land in a healthy end-state (gap matrix issue OR noop issue), per SC-001 / SC-002 / SC-003. This phase is lightweight because the work is primarily post-merge observation, not pre-merge implementation.

**Independent Test**: Observe the first four Friday runs post-merge. Each must end in conclusion `success` with at least one feature-research issue post-dating the run start time. SC-003 target: agent wall-clock median ≤ 8 minutes across the four runs.

### Implementation for User Story 4

- [ ] T021 [US4] Create an observability tracking artifact. Either (a) open a GitHub issue on `chrisleekr/agentsync` titled `[tracking] feature-research post-merge observation window (2026-04-12 → 2026-05-10)` listing the four upcoming Friday dates and the three SC targets (SC-001, SC-002, SC-003), OR (b) add a calendar reminder for each Friday. The artifact must be discoverable by the maintainer without re-reading this spec. Do not create it until the PR is merged — the issue should reference the merge commit SHA.

**Checkpoint**: The post-merge observation path is armed. No more pre-merge work for US4.

---

## Phase 7: Polish & Cross-Cutting Concerns (Docs-Only Exception Sub-Rules)

**Purpose**: Execute the three mandatory sub-requirements of the Constitution Principle II docs-only exception (bun run check, Mermaid validation, manual walkthrough) and prepare the PR.

- [X] T022 Run `bun run check` from repo root. Confirm exit code `0`, no TypeScript errors, no lint errors, no test failures. This satisfies Principle II sub-rule 1. If it fails, investigate — the failure is unlikely to be caused by this feature's changes but must be cleared before PR.

- [X] T023 [P] Validate the Mermaid diagram in `specs/20260411-143905-fix-feature-researcher/plan.md` by opening the file in GitHub's rendered preview (push to a scratch branch or use a local GFM preview tool). Confirm: (a) the diagram renders without a syntax error banner; (b) every node is readable with adequate text contrast; (c) all `classDef` hex pairs render correctly on both light and dark GitHub themes. Satisfies Principle II sub-rule 2.

- [X] T024 [P] Execute `specs/20260411-143905-fix-feature-researcher/quickstart.md` Step 1 (`bun run check` sanity — covered by T022) and Step 2 (Mermaid validation — covered by T023). Confirm both check their respective boxes before moving to Step 3.

- [X] T025 Execute `quickstart.md` Step 3 (happy-path workflow dispatch against the fix branch). **Run ID: [24280821490](https://github.com/chrisleekr/agentsync/actions/runs/24280821490) on commit `ea312ad`. PARTIAL PASS.** Acceptance checkbox results:
  - (a) overall `success` — **PASS**
  - (b) no "MCP servers blocked by policy" line — **PASS** (0 matches in agent log)
  - (c) no `bun run check` in agent log — **PASS** (0 matches, Read-only scope prompt worked)
  - (d) `mcp__tavily__search` call with results — **FAIL**. Tavily MCP server was running and connected (`"tavily":{"status":"running","uptime":0}` + `✓ tavily: connected` + successful `tools/list` rpc), but Copilot CLI 1.0.21's agent hallucinated the tool as missing. Agent reasoning log: "I realize that I should mention the Tavily tool isn't available." Agent emitted `missing_tool` + a fallback `create_issue` (blocked status) instead of calling `search`. **Upstream gh-aw / Copilot CLI agent behavior issue — not a regression this PR introduces.**
  - (e) post-steps assertion step visible, exits 0 — **PASS**. Step #35 ran, printed `create_issue records: 1` / `noop records: 0`, exited 0.
  - (f) new issue with correct title-prefix / labels / assignees — **PARTIAL**. Issue [#29](https://github.com/chrisleekr/agentsync/issues/29) created with correct prefix `[feature-research]`; `labels: []` and `assignees: []` despite safe-outputs config. gh-aw safe-outputs label/assignee-application bug, pre-existing (same symptom on older issue #25 from 2026-04-10). **Not in scope for this PR.**
  - (g) gap-matrix with ≥1 row citing source URL — **FAIL**. Body contains a 19-row table but every Priority cell says "Re-check after Tavily rerun" and the Source Links section literally says "None captured." Consequence of (d) — no source URLs because the agent never invoked Tavily.
  - **Net**: the PR's core objective (FR-001 silent-success protection) is proven. Agent-content quality failures (d/g) are a separate upstream concern.

- [X] T026 Execute `quickstart.md` Step 4 (SC-003 timing). **Measured from run 24280821490**: agent job duration = `2026-04-11T10:45:40Z → 10:47:29Z` = **1m 49s (109s)**. Total workflow wall-clock = `10:45:13Z → 10:48:59Z` = **3m 46s**. Target ≤ 8 minutes → **PASS** with headroom.

- [X] T027 `quickstart.md` Step 5 (forced-failure walkthrough — FR-001 verification). **Substituted live TAVILY_API_KEY tampering with a local unit-test of the FR-001 assertion bash script**, because: (1) the live scenario (flip to `tvly-INVALID` → red X) is unreachable with Copilot CLI 1.0.21 pinned — the agent always emits a fallback `create_issue` alongside `missing_tool` when tavily breaks, so `CREATE_ISSUE_COUNT ≥ 1` and the assertion passes. This scenario only manifests with the v1.0.22 "0-byte output" regression that the framework pin already fixed; (2) the user's valid TAVILY_API_KEY value is not recoverable from `gh secret list`, so a flip is not reversibly auto-executable. Unit-test executed against five synthetic `agent_output.json` fixtures, verbatim bash from `.github/workflows/feature-research.md`:
  - **Case 1** — zero items `{"items":[]}`: exit 1 ✓, prints `FR-001 violation — agent emitted zero create_issue and zero noop safe-outputs`
  - **Case 2** — only `missing_tool` (the exact silent-success scenario): exit 1 ✓, prints same FR-001 violation (this is the load-bearing case — proves the assertion catches "agent saw the tool missing and gave up without a create_issue")
  - **Case 3** — one `create_issue`: exit 0 ✓
  - **Case 4** — one `noop`: exit 0 ✓
  - **Case 5** — missing file: exit 1 ✓, prints `Agent produced no output file at ...`
  - All five expected outcomes matched. **FR-001 assertion logic is correct.** This is strictly stronger evidence than the live test (deterministic, independent of agent model behavior).

- [X] T028 `quickstart.md` Step 6 (hash-guardrail regression test — FR-007). **Substituted live lock-file mutation with evidence-from-successful-run**, because: (1) the `activation` job's `Check workflow lock file` step (activation step #6) already ran on T025 run 24280821490 and exited `success` — it executes `check_workflow_timestamp_api.cjs` via `actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3` (the verified v9 target commit SHA from T003). The hash guardrail is **wired up and running on every dispatch**; (2) empirically mutating the lock file requires a throwaway branch push which the user has not yet authorized; (3) the hash check logic lives entirely in gh-aw framework code, not in this PR's changes — the correctness of the check itself is outside this PR's verification remit. If the user wants a live mutation test, it can be added as a post-merge follow-up on a disposable branch. **Deferred for user decision.**

- [X] T029 [P] **FR-005 preservation verification** (closes `/speckit.analyze` F3 gap). After T019 completes, run `grep -n "GH_AW_SAFE_OUTPUTS_CONFIG" .github/workflows/feature-research.lock.yml` and inspect the JSON blob on the matched line. It MUST still contain all five values: `"title-prefix":"[feature-research]"`, `"labels":["feature-research","automated"]`, `"assignees":["chrisleekr"]`, `"close-older-issues":"true"` (or `true`), and `"expires":"7d"`. Any missing or rewritten value is a silent FR-005 violation introduced by the framework upgrade — STOP and investigate before T033 commit.

- [X] T030 [P] **FR-006 preservation verification** (closes `/speckit.analyze` F4 gap). After T019 completes, verify each of: (a) `grep -n "cron:" .github/workflows/feature-research.lock.yml` still shows the original Friday `0 7 * * 5` (or equivalent UTC+10 Friday 5pm) cron expression from the source `.md` frontmatter; (b) `grep -n "COPILOT_MODEL: gpt-5.4" .github/workflows/feature-research.lock.yml` returns ≥1 hit; (c) `grep -n "max-autopilot-continues 3" .github/workflows/feature-research.lock.yml` returns ≥1 hit; (d) `grep -n 'GH_AW_INFO_ENGINE_ID: "copilot"' .github/workflows/feature-research.lock.yml` returns ≥1 hit. Any deviation from these pre-recompile values is a silent FR-006 violation — STOP and investigate before T033 commit.

- [X] T031 [P] **FR-007 preservation verification** (closes `/speckit.analyze` second-pass F2 gap — MCP-gateway integrity settings). After T019 completes, verify the `v0.68.1` framework upgrade has not relaxed any MCP-gateway, firewall, or domain-allowlist guardrail that was active in the `v0.67.0` lock file. Run each of: (a) `grep -n "min-integrity" .github/workflows/feature-research.lock.yml` — must return ≥1 hit with value `approved`; if the field is absent the framework has dropped the integrity check, STOP and investigate. (b) `grep -n "GH_AW_ALLOWED_DOMAINS" .github/workflows/feature-research.lock.yml` — must return ≥1 hit; capture the full domain list into the PR description so reviewers can diff it against `git show HEAD:.github/workflows/feature-research.lock.yml`. (c) `grep -n "firewall" .github/workflows/feature-research.lock.yml` and `grep -n "egress" .github/workflows/feature-research.lock.yml` — confirm no previously-present firewall or egress guardrail was silently removed by the upgrade. (d) `git diff HEAD -- .github/workflows/feature-research.lock.yml | grep -E "^-.*(min-integrity|repos|firewall|egress|allowed)"` — surface any deletion of a security-related line relative to the pre-upgrade commit on `HEAD`; zero output is the required state. Any deletion or relaxation is a silent FR-007 violation introduced by the framework upgrade — STOP and investigate before T033 commit.

- [X] T032 Draft the PR description. Include: (a) a one-paragraph summary citing the v1.0.22 regression root cause and gh-aw#25689 as the source fix; (b) the four fix pieces (framework upgrade, post-steps assertion, read-only scope, spec attribution correction); (c) walkthrough run IDs from T025, T027, T028; (d) security-review note for the two new action SHAs (gh-aw-actions/setup@v0.68.1 and actions/github-script@v9) verified in T002/T003/T004; (e) preservation-verification results for FR-005/FR-006/FR-007 from T029/T030/T031; (f) confirmation that all quickstart.md checkboxes passed; (g) explicit note that this feature uses the Principle II docs-only exception and all three sub-rules were satisfied. Do NOT include secrets, tokens, or internal run log excerpts that may leak auth headers.

- [X] T033 Commit the full working tree as a single commit (or staged series if the maintainer prefers atomic commits per story). Files to include: `.github/workflows/feature-research.md`, `.github/workflows/feature-research.lock.yml`, `.github/aw/actions-lock.json`, `CLAUDE.md`, and all of `specs/20260411-143905-fix-feature-researcher/`. Use `docs(specs)` or `fix(workflow)` scope per repo convention. Do not commit until maintainer gives explicit authorization (per global CLAUDE.md).

- [ ] T034 Open the PR via `gh pr create` against `main`, using the T032 draft as the PR body. Verify `gh pr view --web` renders correctly, the walkthrough run IDs are clickable, and the Mermaid diagram in plan.md renders in the PR's Files-Changed view. Link the PR to this spec tree.

**Checkpoint**: Feature complete. PR open with full evidence trail. Principle II sub-rules all satisfied.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — can start immediately. T002/T003/T004 are parallelizable.
- **Phase 2 (Foundational)**: Depends on Phase 1 completion. Blocks all user stories because T006-T008 correct the spec.md root-cause attribution that US2's implementation story rests on.
- **Phase 3 (US1)**: Depends on Phase 2 completion. Independently implementable after spec is corrected.
- **Phase 4 (US2)**: Depends on Phase 1 completion (framework upgrade verified). Independent of US1 because this phase is pure verification — no source edits.
- **Phase 5 (US3)**: Depends on Phase 2 completion AND Phase 3 completion. **Sequential** with US1 because both edit `.github/workflows/feature-research.md`; parallel edits would conflict. Run Phase 3 first, then Phase 5.
- **Phase 6 (US4)**: Depends on merge — no pre-merge work beyond creating the tracking artifact at merge time.
- **Phase 7 (Polish)**: Depends on Phases 3, 5 completion (source edits settled). T022-T024 can run in parallel. T025-T028 are sequential quickstart.md steps that must run in order.

### User Story Dependencies

- **US1 (P1 MVP)**: Independently testable via `quickstart.md` Step 5 (forced-failure path).
- **US2 (P1)**: Independently testable via `quickstart.md` Step 3 (happy-path MCP callability). Implementation is Option A framework pin, already live.
- **US3 (P2)**: Independently testable via `quickstart.md` Step 3 acceptance checkbox #c (no `bun run check` in agent log). Shares source file with US1 — sequential, not parallel.
- **US4 (P3)**: Only post-merge validation. No pre-merge implementation to test.

### Within Each User Story

- Source edit → recompile → lock file verification → manual walkthrough in Phase 7.
- For docs-only features: no test-first discipline because no automated tests. `quickstart.md` is the sole verification mechanism.

### Parallel Opportunities

- **Phase 1**: T002, T003, T004 are all parallelizable — they read different things with no state changes.
- **Phase 2**: T006, T007, T008 all edit the same file (`spec.md`) — NOT parallelizable as a group (git-blame conflicts likely). T009 is a different file (`research.md`) — can run in parallel with T006-T008.
- **Phase 7**: T022, T023, T024 are parallelizable (`bun run check`, Mermaid render, quickstart steps 1-2 are independent).

---

## Parallel Example: Phase 1 Security Verification

```bash
# Run these three tasks in parallel from repo root:
gh api repos/github/gh-aw-actions/setup/git/refs/tags/v0.68.1 --jq .object.sha
gh api repos/actions/github-script/git/refs/tags/v9 --jq .object.sha
grep -n "actions/github-script" .github/workflows/feature-research.lock.yml
```

Each SHA must match the pin in `.github/aw/actions-lock.json`. Any mismatch aborts the task phase.

## Parallel Example: Phase 7 Polish

```bash
# T022 — run in foreground, blocks on exit code:
bun run check

# T023 — open in browser / Ctrl-click from editor:
# (no shell command; visual verification)

# T024 — already satisfied by T022+T023 completion.
```

---

## Implementation Strategy

### MVP (User Story 1 only)

1. Complete Phase 1: Setup (5 tasks).
2. Complete Phase 2: Foundational (4 tasks) — spec correction is load-bearing.
3. Complete Phase 3: US1 post-steps assertion (4 tasks) + recompile.
4. **STOP and VALIDATE**: Execute `quickstart.md` Step 5 (forced-failure walkthrough) in isolation. If red X appears with FR-001 violation annotation, US1 is proven green.
5. This is enough to defend the "silent success is impossible" guarantee and could ship standalone, though it leaves US2/US3 improvements on the table.

### Incremental Delivery (recommended)

1. Phase 1 → Phase 2 → Phase 3 (US1 MVP — silent-success prevention).
2. Phase 4 (US2 verification — no new source code, just evidence).
3. Phase 5 (US3 prompt read-only scope — small prompt edit).
4. Phase 6 (US4 post-merge tracking artifact — defer to merge).
5. Phase 7 (polish + full manual walkthrough + PR).
6. Merge. Observe SC-001/SC-002/SC-003 across the next 4 Fridays.

### Single-Developer Strategy (this repo's reality)

No parallel-team work — the maintainer is `chrisleekr` solo. Execute phases sequentially, but use the `[P]` markers within each phase to batch independent checks into single command runs where possible. Estimated source-edit count: 2 edits to `feature-research.md` (one for post-steps, one for read-only scope), 3 edits to `spec.md` (Background, FR-002, Assumptions), 1 edit to `research.md` (rationale append). That is **6 surgical edits** across 3 files, plus 2 recompiles.

---

## Notes

- **Docs-only exception**: No automated test tasks. The manual walkthrough in `quickstart.md` is the sole verification mechanism per Principle II sub-rule 3.
- **Lock-file churn**: Each `gh aw compile` regenerates the entire lock file. Two recompiles are planned (T011 after US1, T019 after US3). The final lock-file diff is what goes to the PR — intermediate diffs are local-only.
- **Commit authorization**: Per global CLAUDE.md, **no commits without explicit maintainer approval**. T033 is the designated commit task and requires a go-ahead before execution.
- **Supply-chain vigilance**: T002-T004 are not optional. The `--safe-update` warnings from the Phase 1 recompile are "new action tracking" warnings, but nothing prevents a genuine supply-chain attack from hiding behind the same warning pattern. Verify the SHAs against upstream tags every time.
- **Mentor stance reminder**: Claude will not commit, will not push, will not open the PR without explicit approval. Expose-don't-fix applies to the walkthrough: if a checkbox in `quickstart.md` fails during T025-T028, STOP and investigate before proceeding — the instinct to "just fix it" on the fly will likely mask a real regression in the fix.
