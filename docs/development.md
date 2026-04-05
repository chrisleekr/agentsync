# Development Guide

## Purpose

Use this guide when you need to run AgentSync locally, verify a change, or understand the contributor workflow without reading the source tree first.

## Prerequisites

- Bun 1.3.9 or later
- Git access to the vault remote you plan to test against
- A local shell with access to supported agent config directories if you want end-to-end sync validation

## Install and verify

```bash
bun install
bun run check
```

`bun run check` is the baseline gate for this repository. It runs typecheck, Biome, and Bun tests in sequence.

## Local workflow

1. Initialize a vault with `bun run src/cli.ts init --remote <url> --branch <branch>`.
2. Push local configs with `bun run src/cli.ts push`.
3. Pull vault configs with `bun run src/cli.ts pull`.
4. Inspect drift with `bun run src/cli.ts status`.
5. Run diagnostics with `bun run src/cli.ts doctor` when setup looks wrong.

## Common contributor loop

```bash
bun run typecheck
bun run lint
bun run test
```

Use `bun run lint:fix` only when you intend to accept Biome rewrites. Keep documentation and JSDoc edits in the same change as the implementation they describe.

## First-success path

For a quick manual validation:

1. Run `init` against a disposable vault remote.
2. Run `push --agent claude` or plain `push` if you have multiple supported agents configured.
3. Run `pull` and confirm the apply side completes without errors.
4. Run `status --verbose` if you need to inspect hash-level drift.

## Platform notes

- macOS uses `~/Library/...` paths for several agent and daemon locations.
- Linux uses `~/.config/...` paths for most config and service files.
- Windows uses `%APPDATA%` and a named pipe for daemon IPC.

The exact resolved paths live in `src/config/paths.ts`. Use that module as the source of truth, not shell assumptions.

## When to branch into deeper docs

- Use [architecture.md](architecture.md) when a code change touches sync flow, daemon behavior, or security boundaries.
- Use [command-reference.md](command-reference.md) when a command contract changes.
- Use [troubleshooting.md](troubleshooting.md) when reproducing setup, key, or remote failures.
- Use [maintenance.md](maintenance.md) before merging changes that alter exported symbols or user-facing behavior.
