# AgentSync — Project Context for Claude

A Bun-based CLI and background daemon that snapshots local AI agent
configuration (Claude, Cursor, Codex, Copilot, VS Code), encrypts it with
[age](https://age-encryption.org/) recipients, and syncs it through a
Git-backed vault. Read [`README.md`](./README.md) for the user-facing
overview and [`docs/architecture.md`](./docs/architecture.md) for the
system model.

## Tech stack

- **Runtime**: Bun ≥ 1.3.9 (also typechecked via `tsc`)
- **Language**: TypeScript 6.x, strict mode (`"strict": true`)
- **CLI**: [`citty`](https://github.com/unjs/citty)
- **Prompts / output**: [`@clack/prompts`](https://github.com/bombshell-dev/clack), [`picocolors`](https://github.com/alexeyraspopov/picocolors)
- **Encryption**: [`age-encryption`](https://github.com/FiloSottile/typage) (X25519 recipients)
- **Archive**: [`tar`](https://github.com/isaacs/node-tar) v7 (skill bundles)
- **Git ops**: [`simple-git`](https://github.com/steveukx/git-js)
- **Validation**: [`zod`](https://zod.dev) v4
- **Config**: TOML via [`@iarna/toml`](https://github.com/iarna/iarna-toml)
- **Lint / format**: Biome (`biome.json`)
- **Hooks**: Lefthook (`lefthook.yml`)

## Project structure

```text
src/
  cli.ts                  CLI entry — wires citty commands
  agents/                 Per-agent adapters (claude, cursor, codex, copilot, vscode)
  commands/               User-facing commands (init, push, pull, status, daemon, key, skill, …)
  config/                 Path resolution + agentsync.toml schema
  core/                   encryptor, git, sanitizer, tar, watcher, sync-queue, ipc
  daemon/                 Long-running process + per-OS installers
  lib/                    Shared utilities (logging, debug)
  migrate/                Vault format migrations
  test-helpers/           Shared test fixtures
docs/                     Architecture, command reference, daemon, troubleshooting
specs/                    speckit feature specs and plans
scripts/                  Build / packaging scripts
```

Tests live in co-located `__tests__/` directories beside the code under test
(e.g. `src/core/__tests__/git.test.ts`). There is **no** top-level `tests/`.

## Commands

```bash
bun run check         # typecheck + biome + bun test (run before pushing)
bun run typecheck     # tsc --noEmit
bun run lint          # biome ci
bun run lint:fix      # biome check --write
bun test              # bun's native test runner
bun test --coverage   # with coverage
bun run build         # compile single binary to dist/agentsync
bun run check:act     # run CI workflow locally via nektos/act
```

## Conventions and gotchas

- **Encryption is non-negotiable**: every artifact written to the vault must
  go through `src/core/encryptor.ts`. `src/core/sanitizer.ts` enforces
  hard never-sync patterns and aborts the push when literal secrets are
  detected — do not loosen these without a documented reason.
- **Reconciliation is fast-forward-only**: `src/core/git.ts` defines the
  shared rule used by `init`, `pull`, `push`, `key add`, `key rotate`, and
  the daemon. Diverged history must stop the operation with recovery
  guidance — never silently merge or print success.
- **Skill removal is explicit**: vault skills are only removed via
  `agentsync skill remove <agent> <name>`. Snapshot, pull, and status are
  additive by construction.
- **Path resolution**: always resolve agent paths through `AgentPaths` in
  `src/config/paths.ts` rather than hardcoding `~/.claude`, `~/.cursor`,
  etc. — this keeps the test harness and platform overrides working.
- **Errors over fallbacks**: prefer surfacing reconciliation, encryption,
  or daemon-IPC failures with actionable guidance over silent retries or
  defaults.
- **Imports**: ES modules only (`"type": "module"`). Use Node-style
  imports with explicit `.ts` paths where Bun requires them; let Biome
  organise import order.

## Speckit

Feature work is scaffolded under `specs/<timestamp>-<slug>/` via the
speckit skills. The current plan, if any, is in the most recent spec
directory — read it for the active feature's terminology, constraints,
and acceptance criteria before making changes adjacent to that work.

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->

<!-- SPECKIT START -->

For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan.

<!-- SPECKIT END -->
