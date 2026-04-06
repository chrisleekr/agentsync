---
# Trigger - when should this workflow run?
on:
  schedule: weekly on friday around 5pm utc+10
  workflow_dispatch:

permissions:
  contents: read
  issues: read
  pull-requests: read

engine: claude

network: defaults

secrets:
  TAVILY_API_KEY: ${{ secrets.TAVILY_API_KEY }}

safe-outputs:
  create-issue:
    title-prefix: "[feature-research]"
    labels: [feature-research, automated]
    assignees: [chrisleekr]
    close-older-issues: true
    expires: 7
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

- **Cursor**: `aicontext.personalContext` (SQLite), `.cursorrules`, `.cursor/rules/`
- **Claude Code**: `~/.claude.json` (MCP), `~/.claude/settings.json` (hooks)
- **Copilot**: `~/.copilot/instructions/`, `~/.copilot/skills/`, `~/.copilot/agents/`
- **Codex**: `~/.codex/config.toml`, `~/.codex/instructions.md`
- **VS Code**: `settings.json`, `.vscode/mcp.json`, `.github/copilot-instructions.md`

## Output

Create a GitHub issue containing:

1. A gap matrix table:

   | Agent | Config Field | Currently Synced? | Priority |
   | ----- | ------------ | ----------------- | -------- |

2. Source links to the changelog entries or release notes you found
3. Recommended implementation order with rationale
4. If nothing new was detected: state "No gaps detected this week"
