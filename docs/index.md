# AgentSync

> Snapshot, encrypt, and sync AI agent configs — Claude, Cursor, Codex, Copilot, VS Code — across machines via a Git vault.

AgentSync is a CLI and background daemon that captures the local
configuration of your AI coding assistants, encrypts each artifact with
[age](https://age-encryption.org/) recipients, and stores the result in
a private Git repository (the **vault**). Pull on any other machine and
you have the same agents, the same skills, the same workflows — without
ever putting plaintext secrets in Git.

## Why?

- **One source of truth across machines.** Move from your laptop to a
  desktop without re-installing agents or losing skill bundles.
- **Encryption is non-negotiable.** Every byte in the vault is encrypted
  before it leaves your machine. The Git remote sees ciphertext.
- **Sanitizer first.** Hard-coded never-sync patterns and literal-secret
  detection abort the push *before* anything is written.
- **Fast-forward only.** Reconciliation refuses divergent history rather
  than silently merging.

## Where to next?

<div class="grid cards" markdown>

-   :material-rocket-launch: **Get started in five minutes**

    Install the CLI, create your first vault, push from machine A, pull
    on machine B.

    [:octicons-arrow-right-24: Getting Started](getting-started.md)

-   :material-sitemap: **Understand the system**

    A high-level tour of the encrypt → sanitize → reconcile pipeline,
    then a deep dive into the internals.

    [:octicons-arrow-right-24: Architecture Overview](architecture-overview.md)

-   :material-console: **Look up a command**

    Every flag for `init`, `push`, `pull`, `daemon`, `key`, `skill`, …

    [:octicons-arrow-right-24: Command Reference](command-reference.md)

-   :material-wrench: **Operate it day-to-day**

    Daemon installs, key rotation, troubleshooting, vault migrations.

    [:octicons-arrow-right-24: Daemon](daemon.md)

</div>

## Project status

AgentSync is pre-1.0. The vault format is versioned and migrations are
shipped through `agentsync migrate` — see [Migrations](migrate.md). The
public CLI surface is stable; internal APIs may move between minors.
