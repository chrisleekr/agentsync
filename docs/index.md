---
title: AgentSync
description: Sync AI agent configs across machines. Encrypted Git-backed vault for Claude, Cursor, Codex, Copilot, VS Code, and OpenCode. Install guide and quickstart.
hide:
  - navigation
---

# AgentSync

Snapshot, encrypt, and sync your AI agent configurations across machines through a Git-backed vault. Plaintext never leaves the machine.

## What this page owns

The front door. It owns the pitch, the install commands, and the routing to the rest of the documentation. Every concept is owned by a single deeper page; this page only points at them.

## Install

The primary path is a global install with [Bun](https://bun.sh) 1.3.9 or later.

```bash
bun install -g @chrisleekr/agentsync
agentsync --version
```

After the global install, every example in the rest of this site runs as plain `agentsync <command>`.

If you would rather not install globally, use `bunx`:

```bash
bunx --package @chrisleekr/agentsync agentsync --version
```

The `bunx` form is fully supported. It is slower on cold runs because it fetches the package each time, but it keeps your machine clean.

The GitHub Release record is the canonical source for the version you are installing and what changed in it. Start at the [latest release](https://github.com/chrisleekr/agentsync/releases/latest). Standalone compiled binaries are published there alongside SHA256 checksums and Sigstore build provenance attestations — see [Operations → Verifying release binaries](operations.md#verifying-release-binaries) for the one-line check.

## Quickstart

Five steps from zero to a working sync.

> Tip: once you have run `init` once, running `agentsync` with no arguments
> opens an interactive TUI that covers vault browsing, per-agent local view,
> push, browsing other machines and copying from them, and migrate. See
> [Commands → tui](commands.md#tui).

1. **Create an empty Git repo** to act as the vault. A private GitHub or GitLab repo works. Nothing in it will ever contain plaintext.
2. **Initialise on the first machine.** `agentsync init` generates an age keypair, registers it as a recipient, writes `agentsync.toml`, and clones the empty vault.

    ```bash
    agentsync init --remote git@github.com:<you>/agentsync-vault.git --branch main
    ```

3. **Push your current agent config.** `agentsync push` walks every enabled agent path, runs the sanitiser, encrypts, and fast-forwards the vault.

    ```bash
    agentsync push
    ```

4. **Join from another machine.** On the second machine, `init` generates a fresh age keypair; on a machine that already has the vault, register the new public key as a recipient (`agentsync key add <name> <pubkey>` and push). Then, back on the new machine, `copy` the config you want from any machine's namespace (use `copy self …` once it has its own backup).

    ```bash
    # on the new machine
    agentsync init --remote git@github.com:<you>/agentsync-vault.git --branch main
    # then on a machine that already has the vault, add the new recipient and push:
    #   agentsync key add <name> <pubkey-printed-by-init>
    #   agentsync push
    # back on the new machine, bring down another machine's config:
    agentsync copy <other-machine> claude/
    ```

Detailed flag, outcome, and caveat tables live in [Commands](commands.md).

## Why?

- **Plaintext never crosses the network.** Every artefact in the vault is encrypted to one or more age recipients before any Git operation runs.
- **Fast-forward only.** Reconciliation never merges silently. If two machines diverge, AgentSync stops and prints a recovery path.
- **Sanitiser is a hard gate.** Literal secrets and never-sync paths abort the push before any bytes leave the machine.
- **Vault removal is explicit.** `copy` is additive by design so an in-progress local edit cannot be wiped by a remote that omits it. Deletion is never silent: the CLI `agentsync skill remove` deletes a skill, and the TUI Sync tab removes any selected vault artifact after a `y`/`n` confirm — both routed through one `performVaultRemove` core.
- **Interactive TUI.** Running `agentsync` with no subcommand opens a tabbed UI to browse the vault, inspect per-agent local content, trigger a push, browse machines and copy from them, and migrate config — without memorising flags.

## Where to go next

<div class="grid cards" markdown>

- :material-sitemap: **[Architecture](architecture.md)** — system model, vault format, push and copy pipelines, security boundaries.
- :material-console: **[Commands](commands.md)** — every subcommand, flag, outcome, and caveat in one reference.
- :material-swap-horizontal: **[Migrate](migrate.md)** — translate config between Claude, Cursor, Codex, Copilot, VS Code, and OpenCode.
- :material-cog: **[Operations](operations.md)** — key rotation, troubleshooting catalogue.
- :material-account-wrench: **[Contributing](contributing.md)** — develop from source, run the test suite, release discipline, doc ownership.

</div>

## Project status

AgentSync is pre-1.0. The CLI surface is stable enough to depend on for personal use across machines, but the vault format is versioned and may change in a minor release. Format migrations are recorded in [Migrate](migrate.md).
