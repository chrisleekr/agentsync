# Getting Started

This page takes you from a fresh machine to a working two-machine sync
in about five minutes. For the full flag-by-flag rundown, see the
[Command Reference](command-reference.md).

## 1. Install

The published CLI ships through the npm registry as
`@chrisleekr/agentsync` (pure-JavaScript bundle) and through GitHub
Releases as compiled single-file binaries. Pick whichever matches your
environment.

=== "bunx (recommended)"

    No global install needed. Requires [Bun](https://bun.sh) on `PATH`.

    ```bash
    bunx --package @chrisleekr/agentsync agentsync --version
    ```

    Every other example on this page uses bare `agentsync …`; with
    `bunx` you prefix with `bunx --package @chrisleekr/agentsync `.

=== "Pre-built binary"

    Single static binary, no Bun runtime required. Pick the artifact
    that matches your platform from the
    [latest release](https://github.com/chrisleekr/agentsync/releases/latest):
    `agentsync-linux-x64`, `agentsync-linux-arm64`,
    `agentsync-macos-arm64`, or `agentsync-macos-x64`.

    ```bash
    # macOS arm64 example
    curl -L -o agentsync \
      https://github.com/chrisleekr/agentsync/releases/latest/download/agentsync-macos-arm64
    chmod +x agentsync
    sudo mv agentsync /usr/local/bin/
    agentsync --version
    ```

    !!! warning "macOS Gatekeeper"
        The macOS binaries are unsigned. The first run is killed by
        Gatekeeper with exit code 137 (SIGKILL). Clear the quarantine
        attribute before running:
        `xattr -d com.apple.quarantine /usr/local/bin/agentsync`.

=== "From source"

    For contributors and unreleased work — see [Development](development.md)
    for the full source workflow.

    ```bash
    git clone https://github.com/chrisleekr/agentsync
    cd agentsync
    bun install
    bun run build           # produces dist/agentsync (compiled binary)
    ./dist/agentsync --version
    ```

You also need a private Git repository to use as the **vault remote** —
GitHub, GitLab, Gitea, or any reachable Git server. The age keypair
that protects the vault contents is generated for you on first `init`;
you do not need to install the `age` CLI separately.

## 2. Create the vault on Machine A

```bash
agentsync init \
  --remote git@github.com:you/agentsync-vault.git \
  --branch main
```

`init` does five things:

1. Creates the local vault checkout at `~/.config/agentsync/vault/`
   (or `%APPDATA%\agentsync\vault\` on Windows).
2. Generates an age keypair at `~/.config/agentsync/key.txt` if one
   does not already exist.
3. Either clones the remote (if it has commits) or wires `origin` and
   prepares the first commit.
4. Writes `~/.config/agentsync/vault/agentsync.toml` recording your
   machine name, the recipient public key, and the configured agents.
5. Creates an initial `init: <machine-name>` commit.

!!! warning "Back up your private key"
    `~/.config/agentsync/key.txt` is the **only** thing that can
    decrypt the vault. Lose it and the vault is unreadable. Back it up
    to a password manager *before* your first `push`.

## 3. Push your first snapshot

```bash
agentsync push
```

Behind the scenes `push`:

1. Walks the per-agent paths (Claude, Cursor, Codex, Copilot, VS Code).
2. Runs the **sanitizer** — aborts on literal secrets, applies
   never-sync patterns. See [Architecture](architecture.md).
3. **Encrypts** each artifact with the age recipients listed in
   `agentsync.toml`.
4. **Fast-forwards** the vault, refusing if the remote has diverged.

If the sanitizer aborts, fix the flagged file and re-run — `push` is
all-or-nothing. There is no partial state in the vault.

## 4. Pull onto Machine B

On a second machine, install the CLI, then:

```bash
# Copy ~/.config/agentsync/key.txt from Machine A to the same path
# on Machine B BEFORE the first init — required for decrypt.

agentsync init --remote git@github.com:you/agentsync-vault.git
agentsync pull
```

`pull` is **additive**: it never deletes a local file the vault doesn't
know about. To remove a skill from the vault, use the explicit
`agentsync skill remove <agent> <name>` (the only non-additive command).

## 5. (Optional) Run the daemon

The daemon watches your agent paths and pushes on change, with
debouncing and a sync queue. Installation is the same on every OS —
the CLI dispatches to the right backend (launchd / systemd / Windows
Task Scheduler) for you.

```bash
agentsync daemon install   # writes the OS service descriptor
agentsync daemon start     # idempotent
agentsync daemon status    # IPC ping; reports running state + last sync
```

To stop or remove:

```bash
agentsync daemon stop
agentsync daemon uninstall
```

See [Daemon](daemon.md) for the per-OS service paths, log locations,
and IPC protocol.

## Next steps

- [Command Reference](command-reference.md) — every flag, exit code, and example.
- [Architecture Overview](architecture-overview.md) — how the pieces fit.
- [Troubleshooting](troubleshooting.md) — when something goes wrong.
