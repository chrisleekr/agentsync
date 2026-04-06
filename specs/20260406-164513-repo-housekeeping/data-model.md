# Data Model: Repository Housekeeping

**Branch**: `20260406-164513-repo-housekeeping` | **Date**: 2026-04-06

## Overview

This housekeeping feature introduces no new entities or data stores. All changes modify existing interfaces and configuration files.

## Modified Interfaces

### GitReconciliationOptions (src/core/git.ts)

Existing interface with one new field:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| remote | `string` | `"origin"` | Git remote name (existing) |
| branch | `string` | `"main"` | Branch to reconcile (existing) |
| allowMissingRemote | `boolean` | `false` | Skip error if remote branch absent (existing) |
| **force** | **`boolean`** | **`false`** | **Reset local to remote HEAD on diverged history instead of throwing** |

### performPull Options (src/commands/pull.ts)

Existing options object with one new field:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| agent | `string?` | `undefined` | Filter to specific agent (existing) |
| dryRun | `boolean` | `false` | Show actions without applying (existing) |
| **force** | **`boolean`** | **`false`** | **Forward to reconcileWithRemote to skip conflict prompts** |

### AgentDefinition.snapshot (src/agents/registry.ts)

No structural change — the return type `Promise<SnapshotResult>` is unchanged. The modification is to each agent adapter's function signature to directly return `Promise<SnapshotResult>` instead of a narrower type that requires casting.

## Configuration Changes

### package.json

| Field | Before | After |
|-------|--------|-------|
| `devDependencies.bun-types` | `"^1.3.9"` | `"1.3.9"` |
| `dependencies.picocolors` | (absent) | `"^1.1.1"` |

### CI Workflow Matrix (release-please.yml)

| Target | OS Runner | Bun --target | Status |
|--------|-----------|-------------|--------|
| linux-x64 | ubuntu-latest | (native) | Existing |
| macos-arm64 | macos-latest | (native) | Existing |
| **linux-arm64** | **ubuntu-latest** | **`bun-linux-arm64`** | **New** |
| **macos-x64** | **macos-latest** | **`bun-darwin-x64`** | **New** |
