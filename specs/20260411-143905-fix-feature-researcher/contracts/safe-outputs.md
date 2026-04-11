# Contract — `safe-outputs` shape (PRESERVED)

**Status**: **DO NOT CHANGE.** This contract is the shape the workflow
emits today and MUST continue to emit after the fix. Any divergence
fails spec FR-005. This file is a **read-only reference** for task
phase — it does NOT introduce a new contract.

**Source of truth**: compiled `feature-research.lock.yml` line 370 (the
`GH_AW_SAFE_OUTPUTS_CONFIG_*` block) and
`.github/workflows/feature-research.md` frontmatter lines 32–38.

## Producer → Consumer

| Producer | Consumer |
|----------|----------|
| `agent` job calling `mcp__safeoutputs__create_issue` | `safe_outputs` job running `safe_output_handler_manager.cjs` |

## Wire format

One JSON object per record, one record per line in
`/tmp/gh-aw/safeoutputs.jsonl`.

```jsonc
{
  "type": "create_issue",
  "title": "...",          // sanitized, max 128 chars. Will be prefixed by safe-outputs handler with "[feature-research] "
  "body": "...",           // sanitized, max 65000 chars (markdown)
  "labels": ["..."],       // max 128 chars each, sanitized. MUST include "feature-research" and "automated"
  "assignees": ["..."],    // MUST include "chrisleekr"
  "temporary_id": "..."    // gh-aw internal; agent leaves blank
}
```

Validation schema is in the compiled lock under
`safeoutputs/validation.json` — the `create_issue` entry with
`required: ["body", "title"]`.

## Frontmatter declaration (MUST remain exactly as shown)

```yaml
safe-outputs:
  create-issue:
    title-prefix: "[feature-research]"
    labels: [feature-research, automated]
    assignees: [chrisleekr]
    close-older-issues: true
    expires: 7d
```

## Invariants the fix must preserve

| Invariant | Why |
|-----------|-----|
| `title-prefix` is `[feature-research]` | spec FR-005 |
| `labels` contains both `feature-research` and `automated` | spec FR-005, SC-001 |
| `assignees` contains `chrisleekr` | spec FR-005 |
| `close-older-issues: true` | spec FR-005 |
| `expires: 7d` | spec FR-005 |
| `create-issue.max` remains `1` | existing gh-aw default; spec does not loosen |
| `noop` safe-output type remains allowed (even though not named in the source frontmatter, gh-aw injects it as a default) | spec User Story 1 scenario 3 needs `noop` for the “no gaps this week” happy-path |

## What the fix MAY change (but is NOT required to change)

- Nothing in this contract. The fix only **reads** safe-outputs (via
  the new post-steps assertion in `contracts/post-check.md`); it does
  not modify how they are produced or consumed.

## Test strategy

No automated test — this is a docs-only feature per Principle II
exception. Manual walkthrough in `quickstart.md` asserts that on a
successful run:

1. A single issue is created (or updated) with the prefix, labels,
   and assignee above.
2. The issue title is visible on `chrisleekr/agentsync/issues` within
   ~30 seconds of the agent job completing.
3. Prior week’s issue is closed by the `close-older-issues` mechanism.
