# Contract — Post-execution assertion (NEW)

**Status**: **NEW** — introduced by this feature to satisfy FR-001.
**Location**: injected into `.github/workflows/feature-research.md`
frontmatter as a `post-steps:` entry. Compiled into the `agent` job
of `feature-research.lock.yml` after the existing “Execute GitHub
Copilot CLI” step.

## Purpose

Make silent-success impossible: fail the agent step when it emits
zero `create_issue` safe-output records and zero `noop` safe-output
records, so the overall run conclusion rolls up as `failure` and the
Actions UI shows a red X.

## Producer → Consumer

| Producer | Consumer |
|----------|----------|
| `post-steps` assertion (new) | GitHub Actions job conclusion resolver |

## Input contract

| Input | Source | Required |
|-------|--------|----------|
| `/tmp/gh-aw/agent_output.json` | Written by existing gh-aw lock step “Write agent output placeholder if missing” at `feature-research.lock.yml:770` | Yes (gh-aw guarantees the file exists — it writes `{"items":[]}` if the agent produced nothing) |

The file shape is a JSON object with an `items` array whose entries
match the `SafeOutputRecord` entity in `data-model.md`.

## Output contract (exit semantics)

| Situation | Exit code | Observable effect |
|-----------|-----------|-------------------|
| `items[].type == "create_issue"` count `>= 1` | `0` | Agent step passes; downstream jobs run as normal |
| `items[].type == "noop"` count `>= 1` (no create_issue) | `0` | Agent step passes; noop tracking issue is created by the existing `handle_noop_message.cjs` step in the conclusion job |
| Both counts are zero | `1` | Agent step fails; `needs.agent.result == "failure"`; conclusion job rolls up as `failure`; **red X in Actions UI** |
| `/tmp/gh-aw/agent_output.json` is missing or not valid JSON | `1` | Same as above — silent-success is impossible even on malformed output |

## Frontmatter declaration

```yaml
post-steps:
  - name: Assert agent emitted at least one safe-output record
    if: always()
    run: |
      set -euo pipefail
      AGENT_OUT=/tmp/gh-aw/agent_output.json
      if [[ ! -s "$AGENT_OUT" ]]; then
        echo "::error::Agent produced no output file at $AGENT_OUT"
        exit 1
      fi
      CREATE_ISSUE_COUNT=$(jq '[.items[] | select(.type == "create_issue")] | length' "$AGENT_OUT")
      NOOP_COUNT=$(jq '[.items[] | select(.type == "noop")] | length' "$AGENT_OUT")
      echo "create_issue records: $CREATE_ISSUE_COUNT"
      echo "noop records:         $NOOP_COUNT"
      if [[ "$CREATE_ISSUE_COUNT" -lt 1 && "$NOOP_COUNT" -lt 1 ]]; then
        echo "::error::FR-001 violation — agent emitted zero create_issue and zero noop safe-outputs. Failing the run to prevent silent success."
        exit 1
      fi
```

## Invariants

| Invariant | Enforcement |
|-----------|-------------|
| `set -euo pipefail` must be at the top of the script | Documented above; reviewers reject PRs without it |
| Error messages go to `::error::` workflow command (not just `echo`) | Makes the failure visible in the Actions UI summary |
| Step uses `if: always()` | Runs even if the agent step crashed (spec Edge Case: max-continuations exhaustion) |
| Script MUST NOT write to `$GITHUB_TOKEN`, MUST NOT read secrets | Post-steps run outside the firewall sandbox; avoid leaking anything from the runner environment |
| Script uses `jq` (pre-installed on `ubuntu-24.04`) | Documented in `docs.github.com/en/actions/reference/runner-images#ubuntu-2404-lts-installed-software` |

## What this contract does NOT cover

- **Signal-to-maintainer-via-email** — spec does not require it.
- **Per-iteration progress tracking** — the agent runs up to 3
  autopilot continuations; this assertion runs once at the end,
  exactly as the agent step completes.
- **Alerting on partial Tavily rate-limit** — spec Edge Case says a
  partial-data run is legitimate success; the assertion only fires on
  zero output, not on degraded output.

## Test strategy

- **Happy path**: `quickstart.md` step 4 dispatches the workflow and
  verifies the post-step passes (green agent job, green run).
- **Forced failure**: `quickstart.md` step 5 temporarily breaks the
  MCP gateway (e.g. by invalidating `TAVILY_API_KEY`) to force zero
  safe-outputs, verifying the assertion fires and the run ends in
  red X.
- **Regression lock-in**: after merge, the next 4 scheduled runs
  (SC-001 window) are observed; any silent-success regression is
  treated as a FR-001 violation and re-opens this spec.
