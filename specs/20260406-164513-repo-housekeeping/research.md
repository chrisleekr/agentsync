# Research: Repository Housekeeping

**Branch**: `20260406-164513-repo-housekeeping` | **Date**: 2026-04-06

## R1: GitHub Actions Version Availability

**Decision**: Pin to `actions/checkout@v4` and `actions/setup-node@v4`

**Rationale**: As of April 2026, `@v4` is the latest stable release for both actions. The repo currently references `@v6` which does not exist — GitHub Actions resolves undefined major tags unpredictably (may fail or fall back). Both `ci.yml` and `release-please.yml` reference these invalid versions.

**Alternatives considered**:
- Pin to SHA instead of tag: More secure against tag reassignment, but harder to maintain. Given this is a personal project, tag-based pinning is sufficient.
- Use Dependabot for action updates: Already configured for npm but not for GitHub Actions. Could be added as a follow-up.

## R2: Bun Cross-Compilation Targets

**Decision**: Add `linux-arm64` and `macos-x64` via Bun's `--target` flag. Defer Windows.

**Rationale**: Bun supports cross-compilation with `--target bun-linux-arm64` and `--target bun-darwin-x64` from any supported runner. These targets cover AWS Graviton, Raspberry Pi, and Intel Mac users. Cross-compilation builds the binary for the target platform without needing a native runner.

**Alternatives considered**:
- Native runners per platform: More reliable but GitHub Actions doesn't offer linux-arm64 runners on free tier. Cross-compilation is the standard approach for Bun CLI tools.
- Include Windows: Deferred — no Windows CI job exists to validate the binary. The `installer-windows.ts` module exists but is untested in CI.

**Implementation note**: The `build-and-upload` matrix needs entries where `os` can remain `ubuntu-latest` for cross-compiled targets. Only `macos-arm64` strictly needs `macos-latest` for native compilation.

## R3: `reconcileWithRemote` Force Behaviour

**Decision**: Add `force?: boolean` to `GitReconciliationOptions`. When `true` and history has diverged, reset local branch to remote HEAD instead of throwing `DIVERGED_HISTORY`.

**Rationale**: The current flow at `src/core/git.ts:302` throws when `this.isAncestor` fails in both directions. The force path should call `git reset --hard {remoteRef}` to align local with remote. This is the expected behaviour described in the existing CLI help text: "Force remote apply without conflict prompts."

**Alternatives considered**:
- Merge with conflict resolution: Too complex for a vault sync tool — conflicts in encrypted `.age` files are meaningless.
- Prompt user interactively: Not viable in daemon mode; force flag is the right escape hatch.

**Safety**: The force path only affects the vault directory, not the user's project repos. The vault is always recoverable from the remote.

## R4: Snapshot Type Cast Removal

**Decision**: Change each agent's snapshot function return type from its specific interface (e.g., `CursorSnapshotResult`) to `SnapshotResult` directly.

**Rationale**: All five agent-specific snapshot result types (`ClaudeSnapshotResult`, `CursorSnapshotResult`, `CodexSnapshotResult`, `CopilotSnapshotResult`, `VsCodeSnapshotResult`) are structurally identical to `SnapshotResult` — both have `{ artifacts: SnapshotArtifact[]; warnings: string[] }`. The `as` casts exist because TypeScript's function type compatibility is checked in the covariant position, but since the types are identical, simply changing the return type annotation eliminates the cast.

**Alternatives considered**:
- Make agent types extend SnapshotResult: Unnecessary — they're already identical.
- Keep specific types and add a mapped type: Over-engineering for identical shapes.

**Note**: The agent-specific types are re-exported from `registry.ts` (lines 60-66). If any consumer depends on the narrow type, keep the type aliases but have them equal `SnapshotResult` directly.

## R5: picocolors Availability

**Decision**: Import `picocolors` directly in `status.ts`. It's already in `node_modules` (v1.1.1) as a transitive dependency of `@clack/prompts`.

**Rationale**: picocolors is a zero-dependency, stable library with a minimal API surface (`pc.green()`, `pc.yellow()`, `pc.red()`, `pc.cyan()`, `pc.dim()`). It auto-detects terminal colour support.

**Colour mapping**:
- `synced` → green
- `local-changed` → yellow
- `vault-only` → cyan
- `local-only` → dim/grey
- `error` → red

**Alternatives considered**:
- Add picocolors to `dependencies`: It's already available as a transitive dep of `@clack/prompts`. However, relying on transitive deps is fragile. Adding it explicitly to `dependencies` (it's 2.6KB) is the safer choice.
- Use ANSI escape codes directly: Less portable, no auto-detection of colour support.
