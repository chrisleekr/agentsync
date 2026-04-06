# Implementation Plan: Repository Housekeeping

**Branch**: `20260406-164513-repo-housekeeping` | **Date**: 2026-04-06 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/20260406-164513-repo-housekeeping/spec.md`

## Summary

Fix 8 verified housekeeping issues across CI configuration (invalid action versions, incomplete binary matrix, missing package smoke test), type safety (unsafe `as` casts in registry, dead `force` arg in pull), dependency hygiene (`bun-types` version drift), and developer experience (colourless status output, silent vault file discard).

## Technical Context

**Language/Version**: TypeScript 6.x, strict mode
**Primary Dependencies**: citty 0.2.x (CLI), @clack/prompts 1.2.x (output), zod 4.x (validation), simple-git 3.x, age-encryption 0.3.x, picocolors 1.1.x (new explicit dep)
**Storage**: Local filesystem (agent config files via `AgentPaths`)
**Testing**: `bun test` with coverage (`bunfig.toml` thresholds: 70% per-file)
**Target Platform**: macOS, Linux (Windows deferred)
**Project Type**: CLI tool
**Performance Goals**: N/A (housekeeping)
**Constraints**: Constitution v1.4.0 compliance; `bun run check` must pass
**Scale/Scope**: ~12 files modified (2 CI YAML, 7 source, 1 package.json, 4 test files), ~100 lines changed

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Security-First Credential Handling | PASS | No credential/encryption changes |
| II. Test Coverage (NON-NEGOTIABLE) | REQUIRES ACTION | New behaviour (force in pull, warning in cursor, colour in status) requires tests. Existing tests for `reconcileWithRemote` need a force-path test. |
| III. Cross-Platform Daemon Reliability | PASS | No daemon changes |
| IV. Code Quality with Biome | PASS | Removing `as` casts improves type safety. `biome ci` must still pass. |
| V. Documentation Standards | PASS | No new exported symbols. JSDoc on modified functions to be updated where behaviour changes. |

- **Test coverage impact**: This is NOT documentation-only. Runtime source files are modified (`pull.ts`, `status.ts`, `cursor.ts`, `registry.ts`, `git.ts`). Automated tests required for:
  - `reconcileWithRemote` force path (success + error)
  - `performPull` forwarding force option
  - `applyCursorVault` warning on unknown `.age` file
  - `status` colour output (verify statusDisplay mapping)
- **Documentation impact**: No Mermaid diagram required — changes are localised fixes, not architectural.

## Project Structure

### Documentation (this feature)

```text
specs/20260406-164513-repo-housekeeping/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (files to modify)

```text
.github/workflows/
├── ci.yml                  # FR-001: Fix action versions; FR-003: Add package smoke test
└── release-please.yml      # FR-001: Fix action versions; FR-002: Expand binary matrix

src/
├── agents/
│   ├── registry.ts         # FR-008: Remove as casts
│   ├── claude.ts           # FR-008: Return SnapshotResult directly
│   ├── cursor.ts           # FR-007: Log warning for unknown .age; FR-008: Return type
│   ├── codex.ts            # FR-008: Return SnapshotResult directly
│   ├── copilot.ts          # FR-008: Return SnapshotResult directly
│   └── vscode.ts           # FR-008: Return SnapshotResult directly
├── commands/
│   ├── pull.ts             # FR-005: Wire force through
│   └── status.ts           # FR-006: Add colour to status display
├── core/
│   └── git.ts              # FR-005: Add force to GitReconciliationOptions

tests/                       # Corresponding test files
├── commands/__tests__/
│   ├── pull.test.ts        # Test force forwarding
│   └── status.test.ts      # Test colour mapping
├── agents/__tests__/
│   └── cursor.test.ts      # Test unknown .age warning
└── core/__tests__/
    └── git.test.ts         # Test force reconciliation path

package.json                 # FR-004: Pin bun-types; add picocolors dep
```

**Structure Decision**: No new directories or files — all changes modify existing source and test files, plus CI YAML.

## Phase 2: Implementation Approach

### Group 1: CI Pipeline Fixes (FR-001, FR-002, FR-003) — Independent

**FR-001 — Fix GitHub Action versions** (~5 min):
- In `ci.yml`: Replace all `actions/checkout@v6` → `@v4`, `actions/setup-node@v6` → `@v4`
- In `release-please.yml`: Same replacements
- Commit type: `fix(ci)`

**FR-002 — Expand binary matrix** (~15 min):
- In `release-please.yml` `build-and-upload` job, add matrix entries:
  - `{ os: ubuntu-latest, target: agentsync-linux-arm64, bun_target: bun-linux-arm64 }`
  - `{ os: macos-latest, target: agentsync-macos-x64, bun_target: bun-darwin-x64 }`
- Update the build step: `bun build --compile --target ${{ matrix.bun_target }} src/cli.ts --outfile dist/${{ matrix.target }}`
  - For existing native entries, omit `--target` or use the equivalent native target
- Commit type: `feat(ci)`

**FR-003 — Add package smoke test** (~10 min):
- In `ci.yml`, add a `build-package` job after `test`:
  ```yaml
  build-package:
    name: Package Smoke Test
    runs-on: ubuntu-latest
    needs: [test]
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.3.9" }
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc }
      - run: bun install --frozen-lockfile
      - run: bun run build:package && npm pack --dry-run
  ```
- Commit type: `feat(ci)`

### Group 2: Type Safety (FR-004, FR-008) — Independent

**FR-004 — Pin bun-types** (~2 min):
- In `package.json`: Change `"bun-types": "^1.3.9"` → `"bun-types": "1.3.9"`
- Run `bun install` to update lockfile
- Commit type: `fix(deps)`

**FR-008 — Remove registry as casts** (~20 min):
- In each agent adapter (`claude.ts`, `cursor.ts`, `codex.ts`, `copilot.ts`, `vscode.ts`):
  - Change the snapshot function return type from `Promise<{Agent}SnapshotResult>` to `Promise<SnapshotResult>`
  - Import `SnapshotResult` from `./_utils`
  - Keep the agent-specific type alias as `type ClaudeSnapshotResult = SnapshotResult` for backwards compatibility of re-exports
- In `registry.ts`: Remove all 5 `as () => Promise<SnapshotResult>` casts
- Verify: `bun run typecheck` must pass
- Commit type: `refactor(agents)`

### Group 3: Pull Force Wiring (FR-005) — Depends on nothing

**FR-005 — Wire force through** (~15 min):
- In `src/core/git.ts`:
  - Add `force?: boolean` to `GitReconciliationOptions` interface
  - In `reconcileWithRemote()`, before the `DIVERGED_HISTORY` throw (line 302), add:
    ```typescript
    if (options.force) {
      this.assertGit(["reset", "--hard", remoteRef], `git reset --hard ${remoteRef}`);
      this.trySetUpstream(branch, remoteRef);
      return {
        status: "fast-forwarded",
        remote,
        branch,
        localHead: await this.revParse("HEAD"),
        remoteHead,
      };
    }
    ```
- In `src/commands/pull.ts`:
  - Add `force?: boolean` to `performPull` options type
  - Pass `force` to `git.reconcileWithRemote()`
  - In `pullCommand.run()`, pass `args.force` to `performPull()`
- Tests:
  - Add test in `git.test.ts`: diverged history + force → resets to remote (status `"fast-forwarded"`)
  - Add test in `pull.test.ts`: verify force option is forwarded
- Commit type: `feat(pull)`

### Group 4: Observability (FR-006, FR-007) — Independent

**FR-006 — Status colours** (~15 min):
- Add `picocolors` to explicit `dependencies` in `package.json`
- In `src/commands/status.ts`:
  - Import `pc` from `picocolors`
  - Change `statusDisplay` mapping to apply colours:
    ```typescript
    const statusDisplay: Record<SyncStatus, string> = {
      synced: pc.green("synced"),
      "local-changed": pc.yellow("local-changed"),
      "vault-only": pc.cyan("vault-only"),
      "local-only": pc.dim("local-only"),
      error: pc.red("error"),
    };
    ```
- Tests: Verify the mapping returns strings containing ANSI escape codes for each status
- Commit type: `feat(status)`

**FR-007 — Cursor vault unknown file warning** (~10 min):
- In `src/agents/cursor.ts`, `applyCursorVault()`:
  - After the `if (name === "user-rules.md.age") ... else if (name === "mcp.json.age")` block, add an `else` branch:
    ```typescript
    else {
      log.warn(`[cursor] Unrecognised vault file skipped: ${name}`);
    }
    ```
- Tests: Add test in `cursor.test.ts`: place unknown `.age` file → verify warning is logged
- Commit type: `fix(cursor)`

### Commit Strategy

Conventional Commits, one commit per FR or logical group:

1. `fix(ci): pin actions/checkout and actions/setup-node to v4` (FR-001)
2. `feat(ci): add linux-arm64 and macos-x64 to release binary matrix` (FR-002)
3. `feat(ci): add package build smoke test to PR pipeline` (FR-003)
4. `fix(deps): pin bun-types to exact version matching .bun-version` (FR-004)
5. `feat(pull): wire --force flag through to reconcileWithRemote` (FR-005)
6. `feat(status): add terminal colour to sync status display` (FR-006)
7. `fix(cursor): warn on unrecognised .age files during vault apply` (FR-007)
8. `refactor(agents): remove unsafe as casts from snapshot registry` (FR-008)

## Constitution Re-Check (Post Phase 1)

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Security-First | PASS | No credential changes |
| II. Test Coverage | PASS | Tests planned for FR-005 (force path), FR-006 (colour mapping), FR-007 (warning), FR-008 (type check) |
| III. Cross-Platform | PASS | No daemon changes |
| IV. Code Quality | PASS | Biome compliance maintained; `as` casts removed |
| V. Documentation | PASS | JSDoc updated for `reconcileWithRemote` and `performPull` signature changes |

## Complexity Tracking

No constitution violations. All changes are straightforward fixes within existing architecture.
