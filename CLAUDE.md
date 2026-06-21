# AgentSync — Project Context for Claude

A Bun-based CLI that snapshots local AI agent
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
  cli.ts                  CLI entry — wires citty commands; bare invocation opens the TUI
  agents/                 Per-agent adapters (claude, cursor, codex, copilot, vscode)
  commands/               User-facing commands (init, push, copy, status, key, skill, plugin, vault, upgrade, …)
    destroy.ts            CLI vault teardown — local rm, remote commit, or both
    tui/                  Interactive TUI: app loop, tab modules, render panes
  config/                 Path resolution + agentsync.toml schema
  core/                   encryptor, git, sanitizer, tar
  lib/                    Shared utilities (logging, debug)
  migrate/                Vault format migrations
  test-helpers/           Shared test fixtures
docs/                     Architecture, commands, migrate, operations, contributing
scripts/                  Build / packaging scripts (build.ts, build-package.ts)
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

- **Encryption is non-negotiable; the secret policy is tiered**: every
  artifact written to the vault goes through `src/core/encryptor.ts`.
  `src/core/sanitizer.ts` enforces hard never-sync patterns plus a
  **catastrophic tier** (`ALWAYS_BLOCK_PATTERNS` — the vault's own age key and
  PEM private keys) that aborts the push in EVERY `secretScan` mode (`off` and
  `redact` included) and is never exemptible via `allowSecretValues`. Ordinary
  API tokens follow the mode: `standard`/`strict` abort; `redact` replaces them
  in structured config with a `$AGENTSYNC_REDACTED_<FIELD>` placeholder and
  pushes (a secret in prose still aborts); `off` waives them. On the apply side,
  redact placeholders are reconciled by `mergePreservingSecrets`
  (`src/core/secret-merge.ts`) — a placeholder never overwrites a real local
  value. Do not loosen these without a documented reason.
- **Per-machine vault layout (v2)**: every artifact lives under
  `machines/<name>/<agent>/…`, composed only through `machineVaultRoot` in
  `src/config/paths.ts` (never hardcode the `machines/` segment). Each machine
  backs up into its own namespace and never overwrites another's. The machine
  name is pinned at `init` (sibling of the key) so a later hostname change
  cannot orphan the namespace.
- **Backup is push-only; `copy` is the only vault→local path**: there is no
  `pull`. `push` snapshots this machine into its namespace; `agentsync copy
  <machine> <path>` is the sole way to apply vault content to local disk (it
  reuses each agent's apply plan via `applySingleArtifact`, writing only local
  disk, never the vault). There is no background sync process — `push` is always
  an explicit action (CLI or TUI), never automatic.
- **Reconciliation is fast-forward-only**: `src/core/git.ts` defines the
  shared rule used by `init`, `push`, `copy`, `key add`, and `key rotate`.
  Diverged history must stop the operation with recovery guidance —
  never silently merge or print success.
- **Integer version is the old-binary block**: `agentsync.toml` carries
  `version` as an INTEGER literal (`z.literal(2)`). A v1 binary's
  `version: z.string()` schema throws on it, so an old binary can never load a
  v2 vault and write flat dirs beside `machines/`. `peekVaultVersion` reads the
  raw version before Zod to route v1→`vault upgrade`, v2→load, >2→upgrade the
  binary.
- **Claude plugins are a manifest, not a tree**: `push` (when
  `claudePlugins.syncPlugins = true`) distils `~/.claude/plugins/{installed_plugins,known_marketplaces}.json`
  into one `claude/plugins.manifest.json.age` (name@marketplace, scope,
  enabled; absolute paths dropped). It has no apply directive — never restored
  on pull/copy — and `agentsync plugin install <machine>` reinstalls by
  shelling to the `claude` CLI.
- **Vault removal is explicit and never silent**: the CLI removes a skill via
  `agentsync skill remove <agent> <name>`; the TUI Sync tab's `x` removes any
  selected vault artifact (skills, commands, configs, rules) after a `y`/`n`
  confirm. Both routes go through the single `performVaultRemove` core in
  `src/commands/vault-remove.ts` (fast-forward reconcile → `git rm` → commit →
  push); `performSkillRemove` is a thin agent-validating wrapper over it.
  Snapshot, copy, and status remain additive by construction — only `x` and
  `skill remove` delete.
- **Path resolution**: always resolve agent paths through `AgentPaths` in
  `src/config/paths.ts` rather than hardcoding `~/.claude`, `~/.cursor`,
  etc. — this keeps the test harness and platform overrides working.
- **TUI reuses command logic, never duplicates it**: the TUI wizards, the
  Machines tab, the Migrate tab, and the Config tab call `performInit`,
  `performKeyAdd`, `performKeyRotate`, `performMigrate`, `performVaultRemove`,
  `performCopy`, and `performConfigSet`/`performConfigList`/`performKeyList`
  directly. Adding new TUI features must not fork business logic — encryption,
  reconciliation, sanitiser, and migration invariants live in one place.
- **`destroy` never imports `AgentPaths`**: the agent-files-never-touched
  invariant for `agentsync destroy` is enforced by construction (no
  `AgentPaths.*` reference anywhere in `src/commands/destroy.ts`) and by
  test (three sha256+mtime assertions in `destroy.test.ts` covering each
  scope). A future PR that adds that import without a documented reason
  should be rejected at review — the invariant is the entire safety story
  for that command.
- **Errors over fallbacks**: prefer surfacing reconciliation or encryption
  failures with actionable guidance over silent retries or defaults.
- **Imports**: ES modules only (`"type": "module"`). Use Node-style
  imports with explicit `.ts` paths where Bun requires them; let Biome
  organise import order.
