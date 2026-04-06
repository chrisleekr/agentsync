# Quickstart: Repository Housekeeping

**Branch**: `20260406-164513-repo-housekeeping` | **Date**: 2026-04-06

## What This Changes

This housekeeping batch fixes 7 verified issues across CI configuration, type safety, dead code, and developer experience. *(Originally 8 — FR-001 was DROPPED after verifying @v6 actions are current.)*

## Validation Steps

### P1: CI Pipeline Correctness

1. ~~**Action versions**~~: **N/A — FR-001 DROPPED**. `actions/checkout@v6` and `actions/setup-node@v6` are already the latest versions. No change needed.
2. **Binary matrix**: In `release-please.yml`, the `build-and-upload` matrix should have 4 entries: linux-x64, linux-arm64, macos-arm64, macos-x64
3. **Package smoke test**: In `ci.yml`, a new `build-package` job should run `bun run build:package && npm pack --dry-run` on PRs

### P2: Type Safety and Code Correctness

4. **Registry casts**: Run `grep "as ()" src/agents/registry.ts` — should return 0 matches
5. **Force arg**: Run `agentsync pull --help` — `--force` should appear with description. Then verify `performPull` accepts `force` option
6. **bun-types pin**: Check `package.json` devDependencies — `bun-types` should be `"1.3.9"` (no caret)

### P3: Observability and DX

7. **Status colours**: Run `agentsync status` — status values should be coloured (green/yellow/cyan/dim/red)
8. **Cursor vault warning**: Place a dummy `.age` file in the cursor vault directory, run `agentsync pull` — a warning about unrecognised file should appear

### All: Regression

9. Run `bun run check` — typecheck, lint, and all tests must pass
10. Verify CI passes on the PR
