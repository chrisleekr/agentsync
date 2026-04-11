---
name: Feature Opportunity Researcher
description: Weekly scan for new agent config fields not yet synced by AgentSync

# Trigger - when should this workflow run?
on:
  schedule: weekly on friday around 5pm utc+10
  workflow_dispatch:

permissions:
  contents: read
  issues: read
  pull-requests: read

engine:
  id: copilot
  model: gpt-5.4
  max-continuations: 3

network:
  allowed:
    - all

mcp-servers:
  tavily:
    command: npx
    args: ["-y", "tavily-mcp@latest"]
    env:
      TAVILY_API_KEY: "${{ secrets.TAVILY_API_KEY }}"
    allowed: ["search", "search_news"]

safe-outputs:
  create-issue:
    title-prefix: "[feature-research]"
    labels: [feature-research, automated]
    assignees: [chrisleekr]
    close-older-issues: true
    expires: 7d

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
---

# Feature Opportunity Researcher

You are a feature researcher for the AgentSync project.
AgentSync syncs AI agent configuration files across developer tools.

## Task

Use the Tavily web search tool to find changelog and release notes published
in the **past 7 days** for each of these tools:

- Cursor IDE
- Claude Code CLI
- GitHub Copilot
- OpenAI Codex CLI
- VS Code

## Important

You MUST use the `mcp__tavily__search` tool for all web searches and content
retrieval. Do NOT use WebFetch or direct HTTP requests to external URLs unless travily is unable to retrieve the content you need.

## Read-only scope

This research task is **read-only** against the working tree. Do NOT run any
repository build, test, or validation command. In particular, do NOT invoke
`bun run check`, `bun install`, `bun test`, `npm test`, `npm install`, `git add`,
`git commit`, or any equivalent. The GitHub-hosted `ubuntu-24.04` runner does
not have Bun installed, and repository validation is not this workflow's job —
your only task is to read source files under `src/agents/*.ts` and compare
them against the upstream changelogs you retrieve through Tavily.

## What to Check

Compare any newly discovered config fields against the current agent
implementations in this repository:

- `src/agents/cursor.ts` — Cursor IDE sync logic
- `src/agents/claude.ts` — Claude Code CLI sync logic
- `src/agents/copilot.ts` — GitHub Copilot sync logic
- `src/agents/codex.ts` — OpenAI Codex CLI sync logic
- `src/agents/vscode.ts` — VS Code sync logic

Read the source files to determine what config fields are currently synced.

## Known Sync Targets (baseline)

> **Authoritative source:** Always read the `src/agents/*.ts` files listed above
> before comparing. The list below is a convenience snapshot — if it conflicts
> with the source code, trust the source code.

- **Cursor**: `settings.json` (`rules` field), `~/.cursor/mcp.json` (MCP servers), `~/.cursor/commands/*.md`
- **Claude Code**: `~/.claude/CLAUDE.md`, `~/.claude/settings.json` (hooks), `~/.claude.json` (MCP servers), `~/.claude/commands/*.md`, `~/.claude/agents/*.md`
- **Copilot**: `~/.copilot/instructions/*.instructions.md`, `~/.copilot/prompts/*.prompt.md`, `~/.copilot/skills/` (directories with SKILL.md), `~/.copilot/agents/` (directories)
- **Codex**: `~/.codex/AGENTS.md`, `~/.codex/config.toml`, `~/.codex/rules/*.md`
- **VS Code**: platform-specific global `mcp.json` (e.g. `~/Library/Application Support/Code/User/mcp.json`)

## Output

Create a GitHub issue containing:

1. A gap matrix table:

   | Agent | Config Field | Currently Synced? | Priority |
   | ----- | ------------ | ----------------- | -------- |

2. Source links to the changelog entries or release notes you found
3. Recommended implementation order with rationale
4. If nothing new was detected: state "No gaps detected this week"
