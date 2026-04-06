# CLI Contract: `agentsync migrate`

**Feature**: `20260406-125441-config-migration`
**Date**: 2026-04-06

## Command Signature

```bash
agentsync migrate --from <agent> --to <agent|all> [--type <config-type>] [--name <artefact>] [--dry-run]
```

## Arguments

| Flag | Type | Required | Values | Description |
|------|------|----------|--------|-------------|
| `--from` | string | yes | `claude`, `cursor`, `codex`, `copilot`, `vscode` | Source agent to read configuration from |
| `--to` | string | yes | `claude`, `cursor`, `codex`, `copilot`, `vscode`, `all` | Target agent(s) to write configuration to |
| `--type` | string | no | `global-rules`, `mcp`, `commands` | Filter to a single config type. Omit to migrate all types. |
| `--name` | string | no | Filename (e.g., `review.md`) | Migrate a single named artefact. Requires `--type`. |
| `--dry-run` | boolean | no | — | Preview changes without writing to disk |

## Validation Rules

1. `--from` and `--to` must be recognised agent names (or `all` for `--to`)
2. `--from` and `--to` must not be the same agent (unless `--to` is `all`)
3. `--name` requires `--type` to be specified
4. `--type` must be one of the defined ConfigType values

## Output Behaviour

### Success (exit code 0)

```text
◆  agentsync migrate

│  → ~/.cursor/mcp.json: cursor MCP servers written
│  → ~/.cursor/commands/review.md: cursor command written
│
└  Migrated 2 artefact(s).
```

### Dry-run (exit code 0)

```text
◆  agentsync migrate --dry-run

│  [dry-run] → ~/.cursor/mcp.json: cursor MCP servers
│  [dry-run] → ~/.cursor/commands/review.md: cursor command
│
└  Dry run complete. 2 artefact(s) would be written.
```

### Error — invalid agent (exit code 1)

```text
✖  Unknown agent "vim". Valid agents: claude, cursor, codex, copilot, vscode
```

### Error — --name without --type (exit code 1)

```text
✖  --name requires --type to be specified
```

### Error — secret detected in MCP content (exit code 1)

```text
✖  Literal secret detected in MCP server "github", field "env.GITHUB_TOKEN"
✖  Migration aborted. Remove secret literals from source config and retry.
```

## Return Type (programmatic)

`performMigrate()` returns `MigrateResult`:

```typescript
interface MigrateResult {
  migrated: MigratedArtifact[];
  skipped: Array<{ reason: string; pair: MigrationPair }>;
  warnings: string[];
  errors: string[];
}
```

- Never throws on missing source files
- `errors` is non-empty for fatal validation failures (invalid agent name, detected secrets in MCP content)
- Individual write failures are caught per-artefact and reported in `errors` without aborting remaining artefacts
