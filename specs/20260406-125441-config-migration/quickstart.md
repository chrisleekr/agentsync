# Quickstart: Cross-Agent Configuration Migration

**Feature**: `20260406-125441-config-migration`
**Date**: 2026-04-06

## Prerequisites

- Bun ≥1.x installed
- At least one AI agent configured on the machine (Claude, Cursor, Codex, Copilot, or VS Code)
- No vault initialisation required — `migrate` operates on local agent config files directly

## Common Workflows

### 1. Migrate everything from Claude to Cursor

```bash
# Preview what would change
agentsync migrate --from claude --to cursor --dry-run

# Apply the migration
agentsync migrate --from claude --to cursor
```

### 2. Migrate only MCP servers from Claude to Codex

Codex uses TOML format for MCP servers while Claude uses JSON. The translator handles the conversion automatically.

```bash
agentsync migrate --from claude --to codex --type mcp
```

### 3. Broadcast Claude config to all agents

```bash
agentsync migrate --from claude --to all
```

This migrates all translatable config types to every compatible agent. Unsupported pairs (e.g., MCP to Copilot) are skipped with a message.

### 4. Migrate a single command file

```bash
agentsync migrate --from claude --to cursor --type commands --name review.md
```

### 5. Migrate Codex MCP (TOML) to VS Code (JSON)

```bash
agentsync migrate --from codex --to vscode --type mcp
```

## What Gets Migrated

| Config Type | What It Contains | Agents That Support It |
|-------------|-----------------|----------------------|
| `global-rules` | Agent instruction files (CLAUDE.md, AGENTS.md, etc.) | Claude, Cursor, Codex, Copilot |
| `mcp` | MCP server definitions | Claude, Cursor, Codex, VS Code |
| `commands` | Command/rule/prompt Markdown files | Claude, Cursor, Codex, Copilot |

## Key Behaviours

- **Overwrite on collision**: If the target already has a matching entry (e.g., same MCP server name), the source value wins
- **MCP per-server merge**: Only colliding server names are overwritten; target-only servers are preserved
- **Secret detection**: If API keys or tokens are found in MCP `env` fields, migration aborts with a clear error. Remove literal secrets from source config (use environment variable references instead) and retry.
- **Graceful skipping**: Missing source files and unsupported pairs produce skip messages, not errors

## Development

### Run tests

```bash
bun test src/migrate/
```

### Type-check

```bash
bun run typecheck
```

### Full CI check

```bash
bun run check
```
