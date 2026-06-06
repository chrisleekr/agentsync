<div align="center">
	<img src="./docs/agentsync-logo.png" alt="AgentSync logo" width="200" height="200"/>
	<h1>AgentSync</h1>
	<h3><em>Encrypted sync for AI agent configuration.</em></h3>
</div>

<p align="center">
	<strong>Snapshot, redact, encrypt, and restore Claude, Cursor, Codex, Copilot, and VS Code setup from a Git-backed vault.</strong>
</p>

<p align="center">
	<a href="https://github.com/chrisleekr/agentsync/releases/latest"><img src="https://img.shields.io/github/v/release/chrisleekr/agentsync" alt="Latest Release"/></a>
	<a href="https://github.com/chrisleekr/agentsync/stargazers"><img src="https://img.shields.io/github/stars/chrisleekr/agentsync?style=social" alt="GitHub stars"/></a>
	<a href="https://github.com/chrisleekr/agentsync/blob/main/LICENSE"><img src="https://img.shields.io/github/license/chrisleekr/agentsync" alt="License"/></a>
	<a href="https://chrisleekr.github.io/agentsync/"><img src="https://img.shields.io/badge/docs-online-blue" alt="Documentation"/></a>
</p>

<div align="center">
	<img src="./docs/demo/tui.gif" alt="AgentSync TUI walkthrough" width="800"/>
</div>

AgentSync is a Bun-based CLI and background daemon that snapshots AI agent configuration from your machine, encrypts it with [age](https://age-encryption.org/) recipients, and backs it up into a Git-backed vault under a per-machine namespace, so you can copy any machine's setup onto another.

It is for people who keep global agent configuration in tools like Claude, Cursor, Codex, Copilot, and VS Code and want one encrypted backup per machine instead of manually copying files between laptops. Each machine pushes into its own `machines/<name>/` namespace; bringing config to a new machine is an explicit `copy`, never a silent overwrite.

## Install

Global install with [Bun](https://bun.sh) 1.3.9 or later:

```bash
bun install -g @chrisleekr/agentsync
agentsync --version
```

Without a global install, run via `bunx`:

```bash
bunx --package @chrisleekr/agentsync agentsync --version
```

## Quickstart

The fastest way in is the interactive TUI. Running `agentsync` with no
arguments opens a tabbed dashboard that lets you browse the vault, inspect
local agent content per agent, trigger a push, browse other machines and copy
from them, and migrate configuration between agents:

```bash
# Open the TUI (or use the explicit alias `agentsync tui`)
agentsync
```

In a non-interactive shell (CI, piped output) bare `agentsync` falls back to
the `status` text output so scripts are not broken.

The flag-driven CLI is still the canonical scripting surface:

```bash
# Initialise a vault and the local machine key
agentsync init --remote git@github.com:<you>/agentsync-vault.git --branch main

# Push local agent configuration into the encrypted vault
agentsync push

# On a new machine, after running init with the same remote, restore another
# machine's config from its vault namespace (use `copy self …` to restore your own)
agentsync copy <other-machine> claude/
```

The full quickstart, command reference, and architecture model live at the documentation site: **<https://chrisleekr.github.io/agentsync/>**.

## Commands

| Command | Why you run it |
|---|---|
| *(bare)* / `tui` | Open the interactive TUI: vault browser, per-agent local view, push, browse machines and copy, and migrate. |
| `init` | Create the local vault workspace, machine key, config, and initial remote state. |
| `push` | Snapshot local agent configs, sanitise secrets, encrypt artefacts, and push to Git. |
| `copy` | Restore an artefact (or subdir) from a machine's vault namespace to local disk (`copy self …` for your own). |
| `status` | Compare local files with the vault and surface drift. |
| `doctor` | Run environment, key, vault, and daemon diagnostics. |
| `daemon` | Install and manage the background auto-sync daemon. |
| `key` | Add recipients or rotate the local machine key. |
| `skill` | Remove a skill from the vault explicitly. |
| `migrate` | Translate configuration between agent formats locally. |
| `destroy` | Wipe the local vault clone (default) or the remote vault contents via a normal commit. **Local agent files (`~/.claude`, `~/.cursor`, …) are never touched.** |

Full flag tables and caveats: [Commands](https://chrisleekr.github.io/agentsync/commands/).

## Documentation

The full documentation is hosted at <https://chrisleekr.github.io/agentsync/> and lives in [`docs/`](./docs):

- **[Architecture](./docs/architecture.md)** — system model, push and copy pipelines, daemon model, security boundaries.
- **[Commands](./docs/commands.md)** — every subcommand, flag, outcome, and caveat.
- **[Migrate](./docs/migrate.md)** — translate config between Claude, Cursor, Codex, Copilot, and VS Code.
- **[Operations](./docs/operations.md)** — daemon install per OS, key rotation, troubleshooting catalogue.
- **[Contributing](./docs/contributing.md)** — develop from source, run the test suite, release discipline, doc ownership.

## Contributing

Clone, verify, and read the contributor guide:

```bash
git clone git@github.com:chrisleekr/agentsync.git
cd agentsync
bun install
bun run check
```

The contributor workflow, the speckit feature flow, release discipline, and doc ownership all live in [Contributing](./docs/contributing.md).

## License

[MIT](./LICENSE).
