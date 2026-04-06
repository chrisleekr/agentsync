# Tasks: Cross-Agent Configuration Migration

**Input**: Design documents from `specs/20260406-125441-config-migration/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/cli-migrate.md

**Tests**: Automated tests are required — this feature introduces new runtime code (translators, orchestrator, CLI command). Constitution Principle II mandates ≥70% line coverage for all new modules.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Create the migration module directory structure and shared type definitions

- [x] T001 Create directory structure: `src/migrate/`, `src/migrate/translators/`, `src/migrate/__tests__/`, `src/migrate/__tests__/translators/`
- [x] T002 Define shared types (ConfigType, MigrationPair, MigratedArtifact, MigrateResult, Translator) in `src/migrate/types.ts` per data-model.md. Also define Zod schema for `MigrateOptions` in `src/config/schema.ts` for CLI argument validation per constitution Principle IV

**Checkpoint**: Type definitions compile with `bun run typecheck`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Translator registry and source-reading infrastructure that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 Implement translator registry with `register()`, `getTranslator()`, and `getSupportedPairs()` in `src/migrate/registry.ts`
- [x] T004 [P] Write tests for registry lookup, missing translator returns null, and `getSupportedPairs()` filtering in `src/migrate/__tests__/registry.test.ts`
- [x] T005 [P] Implement global-rules translators (12 pairwise functions: Claude↔Cursor, Claude↔Codex, Claude↔Copilot, Cursor↔Codex, Cursor↔Copilot, Codex↔Copilot) in `src/migrate/translators/global-rules.ts`
- [x] T006 [P] Implement MCP translators (12 pairwise functions: JSON↔JSON for Claude/Cursor/VS Code, JSON↔TOML for Codex) with per-server merge in `src/migrate/translators/mcp.ts`. Secret detection is handled by the orchestrator, not the translators
- [x] T007 [P] Implement commands translators (12 pairwise functions with `.prompt.md` extension handling for Copilot) in `src/migrate/translators/commands.ts`
- [x] T008 [P] Write fixture-based tests for global-rules translators (empty input returns null, Claude→Cursor returns sentinel, round-trip preservation) in `src/migrate/__tests__/translators/global-rules.test.ts`
- [x] T009 [P] Write fixture-based tests for MCP translators (JSON→JSON identity, JSON→TOML conversion, TOML→JSON conversion, per-server merge preserves target-only servers) in `src/migrate/__tests__/translators/mcp.test.ts`
- [x] T010 [P] Write fixture-based tests for commands translators (filename passthrough, `.prompt.md` suffix added for Copilot, `.prompt.md` stripped from Copilot, empty content returns null) in `src/migrate/__tests__/translators/commands.test.ts`
- [x] T011 Register all translators in `src/migrate/registry.ts` — call `register()` for each (from, to, type) triple per the support matrix in data-model.md

**Checkpoint**: All translator tests pass with `bun test src/migrate/__tests__/translators/`. Registry correctly resolves translators for all supported pairs.

---

## Phase 3: User Story 1 — Migrate Configuration Between Agents (Priority: P1) MVP

**Goal**: Users can run `agentsync migrate --from claude --to cursor` to translate and write all config types

**Independent Test**: Configure Claude with MCP servers + rules + commands, run migrate to Cursor, verify Cursor config files contain correct translated content

### Tests for User Story 1

- [x] T012 [P] [US1] Write orchestrator tests in `src/migrate/__tests__/migrate.test.ts`: source reading via mocked `readIfExists`, translator dispatch, `atomicWrite` calls, summary report structure, graceful handling of missing source files (FR-013), abort on detected secret literals in MCP content (FR-011), write failure on read-only target reports error in `MigrateResult.errors` without crashing (edge case), partial migration failure continues remaining artefacts and reports per-item errors (edge case)
- [x] T013 [P] [US1] Write CLI command tests in `src/commands/__tests__/migrate.test.ts`: argument parsing, validation of `--from`/`--to` agent names (FR-009), error on same source and target, integration with `performMigrate`

### Implementation for User Story 1

- [x] T014 [US1] Implement `readSourceArtefacts(agent, type, filterName?)` in `src/migrate/migrate.ts` — reads source config files using `readIfExists` and `AgentPaths` for each config type (global-rules from file/settings.json, MCP from JSON/TOML, commands from directory listing)
- [x] T015 [US1] Implement `applyMigrated(to, type, targetName, content, dryRun)` in `src/migrate/migrate.ts` — routes writes to existing agent apply functions (`applyCursorRules`, `applyClaudeMcp`, `applyCodexConfig`, etc.)
- [x] T016 [US1] Implement `performMigrate(options)` orchestrator in `src/migrate/migrate.ts` — loops over targets and types, calls `readSourceArtefacts` → translator → secret detection via `redactSecretLiterals` (MCP only, abort with error if secrets found) → `applyMigrated`, builds and returns `MigrateResult`. Catch write errors per-artefact without aborting the entire migration.
- [x] T017 [US1] Implement CLI command in `src/commands/migrate.ts` — define `migrateCommand` with `defineCommand` from citty, parse args (`--from`, `--to`, `--type`, `--name`, `--dry-run`), call `performMigrate`, format output with `@clack/prompts` log functions per contracts/cli-migrate.md
- [x] T018 [US1] Register `migrateCommand` in `src/cli.ts` — add `migrate: migrateCommand` to the `subCommands` object

**Checkpoint**: `agentsync migrate --from claude --to cursor` works end-to-end. All US1 tests pass with `bun test src/migrate/ src/commands/__tests__/migrate.test.ts`.

---

## Phase 4: User Story 2 — Preview Migration Before Applying (Priority: P2)

**Goal**: `--dry-run` previews all changes without writing to disk

**Independent Test**: Run `agentsync migrate --from claude --to cursor --dry-run`, verify zero file modifications and human-readable output listing all intended writes

### Tests for User Story 2

- [x] T019 [US2] Add dry-run test cases in `src/migrate/__tests__/migrate.test.ts`: verify `atomicWrite` / apply functions are NOT called when `dryRun: true`, verify `MigrateResult.migrated` still contains all artefacts (for preview display), verify CLI output includes `[dry-run]` prefix per contracts/cli-migrate.md

### Implementation for User Story 2

- [x] T020 [US2] Verify `performMigrate` correctly passes `dryRun` flag through to `applyMigrated` (already wired in T016), add dry-run output formatting in `src/commands/migrate.ts` CLI command to print `[dry-run] →` prefix for each artefact

**Checkpoint**: `agentsync migrate --from claude --to cursor --dry-run` produces accurate preview output, no files written. US2 tests pass.

---

## Phase 5: User Story 3 — Selective Migration by Config Type (Priority: P3)

**Goal**: `--type mcp` filters migration to a single config type

**Independent Test**: Run with `--type mcp`, verify only MCP config is migrated and global-rules + commands are untouched

### Tests for User Story 3

- [x] T021 [US3] Add type-filtering test cases in `src/migrate/__tests__/migrate.test.ts`: verify only specified type is processed when `type` option is set, verify all types processed when `type` is omitted, verify invalid type value produces error

### Implementation for User Story 3

- [x] T022 [US3] Add `--type` validation in `src/commands/migrate.ts` — validate value is one of `global-rules`, `mcp`, `commands` and surface error for invalid values

**Checkpoint**: `--type` filtering works correctly. US3 tests pass.

---

## Phase 6: User Story 4 — Broadcast Migration to All Agents (Priority: P4)

**Goal**: `--to all` fans out migration to every other registered agent

**Independent Test**: Run `agentsync migrate --from claude --to all`, verify each of the 4 other agents receives translated config where supported, and unsupported pairs (e.g., MCP→Copilot) are skipped with a message

### Tests for User Story 4

- [x] T023 [US4] Add broadcast test cases in `src/migrate/__tests__/migrate.test.ts`: verify `--to all` expands to all agents except source, verify unsupported pairs produce skip entries in `MigrateResult.skipped` with descriptive reasons, verify `--to all --type mcp` only sends MCP to compatible agents

### Implementation for User Story 4

- [x] T024 [US4] Add `--to all` validation in `src/commands/migrate.ts` — validate that `--to all` and `--from` are not the same concept (already handled by expansion logic in `performMigrate`), ensure skip messages are formatted with target agent name

**Checkpoint**: `--to all` correctly fans out to all compatible agents. US4 tests pass.

---

## Phase 7: User Story 5 — Migrate a Single Named Artefact (Priority: P5)

**Goal**: `--name review.md` with `--type commands` migrates only that one file

**Independent Test**: Run with `--type commands --name review.md`, verify only `review.md` appears in target and other command files are untouched

### Tests for User Story 5

- [x] T025 [US5] Add name-filtering test cases in `src/migrate/__tests__/migrate.test.ts`: verify `--name` filters to single artefact, verify `--name` without `--type` produces error, verify `--name` for nonexistent file produces descriptive skip/error message

### Implementation for User Story 5

- [x] T026 [US5] Add `--name` requires `--type` validation in `src/commands/migrate.ts`, pass `name` through to `performMigrate` options which passes to `readSourceArtefacts` `filterName` parameter

**Checkpoint**: `--name` filtering works correctly. US5 tests pass.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, validation, and final quality checks

- [x] T027 [P] Create `docs/migrate.md` with user-facing migration guide including: command reference, config type support matrix table, common workflow examples from quickstart.md, and Mermaid flow diagram from plan.md. Also update `docs/command-reference.md` with the migrate command entry
- [x] T028 [P] Add JSDoc comments to all exported functions in `src/migrate/types.ts`, `src/migrate/registry.ts`, `src/migrate/migrate.ts`, and `src/migrate/translators/*.ts` per constitution Principle V
- [x] T029 Validate Mermaid diagram in `docs/migrate.md` renders correctly
- [x] T030 Run `bun run check` (typecheck + lint + test) — all must pass
- [x] T031 Run quickstart.md validation — manually execute the 5 workflow examples and verify expected output

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (types must exist for registry and translators)
- **User Story 1 (Phase 3)**: Depends on Phase 2 (registry + translators must be registered)
- **User Stories 2–5 (Phases 4–7)**: Depend on Phase 3 (orchestrator + CLI must exist). Can then proceed in parallel.
- **Polish (Phase 8)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (P1)**: Depends on Foundational only — core migration end-to-end
- **US2 (P2)**: Depends on US1 — adds dry-run test coverage and output formatting
- **US3 (P3)**: Depends on US1 — adds `--type` validation and test coverage
- **US4 (P4)**: Depends on US1 — adds `--to all` expansion and test coverage
- **US5 (P5)**: Depends on US1 — adds `--name` validation and test coverage

### Within Each User Story

- Tests written first (TDD) → verify they fail
- Implementation follows to make tests pass
- Checkpoint validation at end of each phase

### Parallel Opportunities

**Phase 2 (Foundational)** — Maximum parallelism:
```text
T005 global-rules translators  ─┐
T006 MCP translators            ├── All in parallel (different files)
T007 commands translators       │
T008 global-rules tests         │
T009 MCP tests                  │
T010 commands tests             ─┘
```

**Phases 4–7 (US2–US5)** — After US1 completes, all can proceed in parallel:
```text
US2 dry-run (T019-T020)        ─┐
US3 --type (T021-T022)          ├── All in parallel
US4 --to all (T023-T024)        │
US5 --name (T025-T026)         ─┘
```

**Phase 8 (Polish)** — docs and JSDoc in parallel:
```text
T027 docs/migrate.md           ─┐
T028 JSDoc comments             ─┘── In parallel
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T002)
2. Complete Phase 2: Foundational (T003–T011)
3. Complete Phase 3: User Story 1 (T012–T018)
4. **STOP and VALIDATE**: Run `bun test` and manually test `agentsync migrate --from claude --to cursor`
5. MVP is usable — core migration works

### Incremental Delivery

1. Setup + Foundational → Types + Registry + Translators ready
2. Add US1 → Core migration works → **MVP**
3. Add US2 → Dry-run preview available
4. Add US3 → Type filtering available
5. Add US4 → Broadcast to all agents
6. Add US5 → Single artefact targeting
7. Polish → Documentation, JSDoc, final validation
8. Each story adds value without breaking previous stories

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable after US1 MVP
- US2–US5 are lightweight (1 test task + 1 implementation task each) because the orchestrator already handles their flags — these phases primarily ensure test coverage
- Translators are pure functions with no side effects — ideal for parallel development and testing
- Secret detection (FR-011) aborts migration if secrets found in MCP content — tested in orchestrator tests (T012), not in translator tests (translators are pure format converters)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
