# Feature Specification: Cross-Agent Configuration Migration

**Feature Branch**: `20260406-125441-config-migration`
**Created**: 2026-04-06
**Status**: Draft
**Input**: User description: "Cross-Agent Configuration Migration (agentsync migrate)"

## Clarifications

### Session 2026-04-06

- Q: Should conflict resolution (interactive prompts, `--force`, `--skip-conflicts`) be in scope? → A: No — overwrite target on collision. Conflict resolution UI deferred to follow-up (`--merge` flag).
- Q: Does `migrate` require prior `agentsync init` (vault setup)? → A: No — `migrate` works standalone using `AgentPaths` only, no vault dependency.
- Q: When migrating MCP servers, should source replace the entire target `mcpServers` block or merge per-server? → A: Per-server merge — overwrite matching server names, preserve target-only servers.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Migrate Configuration Between Agents (Priority: P1)

A user who has a well-configured Claude setup (MCP servers, rules, custom commands) wants to replicate equivalent settings in Cursor without manually recreating each configuration item. The user runs `agentsync migrate --from claude --to cursor` and the tool reads Claude's configuration, maps compatible settings to Cursor's format, and writes them to Cursor's configuration files. If the target already has conflicting entries, they are overwritten.

**Why this priority**: This is the core value proposition — users invest significant time configuring one agent and want to reuse that investment across other agents. Without this, users must manually translate settings between incompatible formats, which is error-prone and time-consuming.

**Independent Test**: Can be fully tested by configuring one agent's settings, running the migrate command, and verifying the target agent's configuration files contain the mapped equivalents.

**Acceptance Scenarios**:

1. **Given** a user has Claude configured with MCP servers, **When** they run `agentsync migrate --from claude --to cursor`, **Then** matching MCP server entries appear in Cursor's configuration with correct format translation
2. **Given** a user has Cursor rules configured, **When** they run `agentsync migrate --from cursor --to claude`, **Then** equivalent rules appear in Claude's configuration with appropriate format adjustments
3. **Given** a source agent has settings with no equivalent in the target agent, **When** migration runs, **Then** unmappable settings are listed in a summary report and the user is informed which items were skipped and why
4. **Given** the target agent already has a conflicting entry (e.g., same MCP server name), **When** migration runs, **Then** the source value overwrites the target value

---

### User Story 2 - Preview Migration Before Applying (Priority: P2)

A user wants to see what changes would be made before committing to a migration. The user runs `agentsync migrate --from claude --to cursor --dry-run` and sees a detailed preview of what would be created, modified, or skipped in the target agent's configuration.

**Why this priority**: Migration modifies configuration files that may already contain custom settings. Users need confidence that migration won't overwrite their existing work before applying changes.

**Independent Test**: Can be tested by running the dry-run command and verifying it produces accurate output without modifying any files on disk.

**Acceptance Scenarios**:

1. **Given** a user runs migrate with `--dry-run`, **When** the command completes, **Then** no target configuration files are modified and a human-readable list of proposed writes is displayed
2. **Given** the target agent already has some configuration, **When** dry-run executes, **Then** the preview clearly shows which files would be created or overwritten

---

### User Story 3 - Selective Migration by Config Type (Priority: P3)

A user wants to migrate only a specific type of configuration (e.g., only MCP servers, only global rules, only commands) rather than everything. The user runs `agentsync migrate --from claude --to cursor --type mcp` to migrate just MCP server configurations.

**Why this priority**: Fine-grained control reduces risk and lets users incrementally adopt settings from another agent without an all-or-nothing approach.

**Independent Test**: Can be tested by migrating a single type and verifying only that type's settings appear in the target, with all other target configuration unchanged.

**Acceptance Scenarios**:

1. **Given** a user specifies `--type mcp`, **When** migration runs, **Then** only MCP server configurations are migrated and all other configuration types remain untouched
2. **Given** a user omits `--type`, **When** migration runs, **Then** all translatable config types are migrated

---

### User Story 4 - Broadcast Migration to All Agents (Priority: P4)

A user wants to propagate their Claude configuration to every other installed agent at once. The user runs `agentsync migrate --from claude --to all` and the tool migrates all translatable configuration to Cursor, Codex, Copilot, and VS Code in a single invocation.

**Why this priority**: Power users who maintain one canonical agent configuration want a single command to fan out updates, rather than running separate commands per target.

**Independent Test**: Can be tested by running `--to all` and verifying each target agent received the expected configuration files.

**Acceptance Scenarios**:

1. **Given** a user runs `agentsync migrate --from claude --to all`, **When** migration completes, **Then** each of the other four agents receives all translatable configuration from Claude
2. **Given** a user runs `--to all --type mcp`, **When** migration completes, **Then** only MCP configurations are migrated to agents that support MCP (Copilot is skipped with a message)

---

### User Story 5 - Migrate a Single Named Artefact (Priority: P5)

A user wants to migrate one specific command file (e.g., `review.md`) from Claude to Cursor without migrating all commands. The user runs `agentsync migrate --from claude --to cursor --type commands --name review.md`.

**Why this priority**: Targeted migration gives users surgical control when they only want to share one artefact.

**Independent Test**: Can be tested by running with `--name` and verifying only that single file appears in the target.

**Acceptance Scenarios**:

1. **Given** a user specifies `--type commands --name review.md`, **When** migration runs, **Then** only `review.md` is migrated and other command files in the source are untouched
2. **Given** a user specifies `--name` for a file that does not exist in the source, **When** migration runs, **Then** the user receives an error message identifying the missing artefact

---

### Edge Cases

- What happens when the source agent has no configuration files present on disk?
- How does the system handle migration between agents where the source has a configuration type (e.g., commands) that has no equivalent concept in the target agent?
- What happens if the target agent's configuration files are read-only or locked by another process?
- What happens when a configuration value references a local file path that exists for one agent's directory structure but not another?
- How does the system handle partial migration failure (e.g., 3 of 5 MCP servers migrate successfully but 2 fail)?
- What happens when MCP server configuration contains secret literals (API keys, tokens)?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a `migrate` command that accepts a source agent (`--from`), a target agent (`--to` including `all`), and optional flags (`--dry-run`, `--type`, `--name`)
- **FR-002**: System MUST read the source agent's configuration from its known file locations without modifying source files
- **FR-003**: System MUST map source configuration items to the target agent's format using a defined mapping between agent configuration schemas
- **FR-004**: System MUST write mapped configuration to the target agent's known file locations, overwriting existing entries on collision. For MCP servers, individual server entries are merged by name — source servers overwrite matching target servers, but target-only servers are preserved
- **FR-005**: System MUST report a summary after migration listing: items successfully migrated, items skipped (with reasons), and items that encountered errors
- **FR-006**: System MUST support a dry-run mode that previews changes without writing to disk
- **FR-007**: System MUST support filtering migration by configuration type (`global-rules`, `mcp`, `commands`)
- **FR-008**: System MUST support targeting a single named artefact via `--name` (requires `--type`)
- **FR-009**: System MUST validate that both source and target agents are recognised names and that source and target are not the same agent before proceeding
- **FR-010**: System MUST support `--to all` to migrate to every other registered agent in a single invocation
- **FR-011**: System MUST apply secret detection (`redactSecretLiterals`) to all translated MCP content before writing to the target. If secrets are detected, the migration MUST abort with a clear error listing the offending fields, consistent with constitution Principle I
- **FR-012**: System MUST support all five currently registered agents (Claude, Cursor, Codex, Copilot, VS Code) as both source and target, subject to the config type support matrix (unsupported pairs are skipped with a message)
- **FR-013**: System MUST never throw on a missing source file — missing sources are reported in the skipped summary

### Config Type Support Matrix

Migration feasibility depends on the source-target pair and config type:

- **Global Rules**: Supported between Claude, Cursor, Codex, and Copilot (all use Markdown-based rules). VS Code has no global rules concept.
- **MCP Servers**: Supported between Claude, Cursor, Codex, and VS Code (JSON `mcpServers` or TOML `[mcp.servers]`). Copilot has no MCP concept.
- **Commands**: Supported between Claude, Cursor, Codex, and Copilot (Markdown files with directory/extension conventions). VS Code has no commands concept.
- **Skills**: Out of scope for this feature — deferred to follow-up issue.

### Key Entities

- **Migration Mapping**: Defines how a configuration concept (e.g., "MCP server") in one agent translates to the equivalent concept in another agent, including format transformations
- **Migration Plan**: The computed set of actions (create, overwrite, skip) that a migration would perform, generated before execution and displayed during dry-run
- **Migration Report**: The post-execution summary of what was migrated, skipped, or errored, including reasons for each outcome
- **Configuration Type**: One of `global-rules`, `mcp`, or `commands` — a logical grouping that can be independently selected for migration via `--type`

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can migrate MCP server configuration between any two supported agents in a single command invocation
- **SC-002**: Dry-run mode accurately predicts 100% of changes that would be applied in a real migration
- **SC-003**: Users receive a clear summary after every migration identifying each item that was migrated, skipped, or errored
- **SC-004**: `--to all` successfully fans out migration to all compatible target agents in a single invocation
- **SC-005**: Secret literals in MCP configuration are detected and cause migration to abort with a clear error before writing to any target agent
- **SC-006**: All translators are covered by automated tests with fixture inputs and expected outputs

## Assumptions

- Source and target agents are installed on the same machine where agentsync runs
- Agent configuration files follow the formats defined in the existing agent registry (no custom or non-standard config locations)
- Migration operates on local configuration files only — it does not require vault initialisation and does not push or pull from the vault
- The existing `AgentPaths` and agent snapshot infrastructure can be leveraged to locate and read source configurations
- All global rules formats are Markdown — translation is wrapping/unwrapping, not semantic transformation
- MCP server schemas share the same logical shape (name, command, args, env) across agents, differing only in serialisation format (JSON vs TOML)
- File path references in configuration content are not rewritten during migration (translators treat content as opaque strings)

## Out of Scope

- **Conflict resolution UI** — if a target file already exists with different content, this feature overwrites. A `--merge` flag is a follow-up.
- **Skills migration** — Copilot's `SKILL.md` directory format has no structural equivalent in other agents. Deferred to follow-up issue.
- **Bidirectional live sync** — migration is an explicit, one-shot command. Automatic daemon-triggered cross-agent migration is a separate feature.
- **Semantic transformation of rule content** — translators treat content as opaque Markdown strings. No LLM rewriting is performed.

## Documentation Impact

- The project README and CLI help text must be updated to document the new `migrate` command and its flags
- A `docs/migrate.md` guide should be created explaining migration concepts, supported mappings between agents, and common workflows
- The `migrate` command must be registered in `src/cli.ts` and documented in `docs/command-reference.md`
