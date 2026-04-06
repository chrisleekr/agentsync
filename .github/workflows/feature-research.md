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
