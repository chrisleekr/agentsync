# Research: Cross-Agent Configuration Migration

**Feature**: `20260406-125441-config-migration`
**Date**: 2026-04-06

## R1: Agent Configuration Format Differences

**Decision**: Use a translator registry pattern — each `(from, to, configType)` triple maps to a pure function that transforms source content to target format.

**Rationale**: Agent configs share the same logical shape but differ in serialisation:
- **Global Rules**: All Markdown-based. Claude uses `CLAUDE.md`, Cursor stores rules as an inline string in `settings.json`, Codex uses `AGENTS.md`, Copilot uses `instructions.md`. Translation is wrapping/unwrapping, not semantic transformation.
- **MCP Servers**: Claude/Cursor/VS Code use JSON `{ "mcpServers": { "<name>": { "command", "args", "env" } } }`. Codex uses TOML `[mcp.servers.<name>]` with the same logical fields. The intermediate representation is a `McpServer[]` array.
- **Commands**: All are Markdown files differing only in directory and file extension convention: `.claude/commands/*.md`, `.cursor/commands/*.md`, `.codex/rules/*.md`, `.copilot/prompts/*.prompt.md`.

**Alternatives considered**:
- Single universal format (rejected: would require all agents to agree on a schema, which is not the case)
- AST-based Markdown transformation (rejected: rules are opaque Markdown strings with no shared structure beyond headings)

## R2: MCP Per-Server Merge Strategy

**Decision**: Read-then-merge at the individual server level. When writing MCP config to a target, read the existing target file, merge source servers into it by name (overwriting collisions), and write back the combined result.

**Rationale**: Users may have target-specific MCP servers that shouldn't be destroyed during migration. The existing `applyClaudeMcp()` and `applyCodexConfig()` already implement this pattern (selective field merge), so migration follows the same convention.

**Alternatives considered**:
- Full file replacement (rejected: would silently destroy target-only servers)
- Deep merge of individual server properties (rejected: over-complex for v1; source server config should be taken as authoritative)

## R3: Secret Detection in Migration Path

**Decision**: Apply `redactSecretLiterals()` from `src/core/sanitizer.ts` to all MCP content after translation but before writing to disk. If any secrets are detected, abort the migration with a clear error listing the offending fields. This reuses the existing 4-pattern regex detection (OpenAI keys, GitHub tokens, Slack bot tokens, base64-like tokens).

**Rationale**: MCP server configs often contain API keys in `env` fields. Constitution Principle I states: "Detected secrets MUST cause the operation to abort with a clear error, not silently redact." Even though migration is local-to-local, the constitution's "abort" requirement applies to all secret detection — no data (even local writes) should proceed with detected secrets. The user should fix the source config (e.g., use environment variable references instead of literal keys) and re-run.

**Alternatives considered**:
- Skip detection for local-only operations (rejected: constitution mandates detection, and migrated config could later be pushed to vault)
- Redact secrets and continue with warnings (rejected: constitution Principle I explicitly says "abort, not silently redact" — /speckit.analyze flagged this as a HIGH finding)

## R4: Cursor Rules Special Handling

**Decision**: Cursor stores global rules as a `rules` string field inside `settings.json`, not as a separate file. The translator returns a sentinel target name (`__cursor_rules__`), and the orchestrator routes this through `applyCursorRules()` which performs a JSON read-modify-write on `settings.json`.

**Rationale**: This is how the existing `applyCursorVault` path works. Reusing it ensures consistency and avoids duplicating the settings.json merge logic.

**Alternatives considered**:
- Writing a `.cursorules` file (rejected: Cursor reads rules from settings.json, not a standalone file in the global config)

## R5: Command File Extension Translation

**Decision**: Commands are Markdown files with agent-specific naming conventions:
- Claude/Cursor: `*.md`
- Codex: `*.md` (in `rules/` directory)
- Copilot: `*.prompt.md`

Translation strips/adds the `.prompt.md` suffix when crossing the Copilot boundary.

**Rationale**: The file content is identical Markdown — only the filename convention differs. The issue's architecture confirms this approach.

**Alternatives considered**:
- Frontmatter injection for agent identification (rejected: adds complexity with no benefit; agents don't read cross-agent frontmatter)

## R6: No New Dependencies Required

**Decision**: The migration feature requires zero new runtime dependencies. All needed capabilities exist:
- `@iarna/toml` for Codex TOML parsing/serialisation
- `@clack/prompts` for CLI output (log.info, log.success, log.warn, log.error)
- `citty` for command definition
- `zod` for argument validation (optional — citty handles basic arg types)
- `readIfExists` / `atomicWrite` from `src/agents/_utils.ts`

**Rationale**: Keeping the dependency footprint unchanged reduces review burden and aligns with constitution Principle IV (dependency additions must be justified).

## R7: Two-Layer Command Pattern

**Decision**: Follow the existing `performPush` / `pushCommand` pattern:
- `src/migrate/migrate.ts` exports `performMigrate(options)` → pure logic, returns `MigrateResult`
- `src/commands/migrate.ts` exports `migrateCommand` → CLI wrapper using `defineCommand`

**Rationale**: This separation enables unit testing of migration logic without CLI scaffolding, consistent with every other command in the project.
