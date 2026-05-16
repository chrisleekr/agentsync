# Operations

Run AgentSync in production for your own laptops: install the daemon, rotate keys, recover from divergence, and diagnose every common failure.

## What this page owns

This page owns day-2 concerns. It is the single home for the daemon install procedure on each OS, the key-rotation runbook, the release binary verification recipe, and the troubleshooting catalogue. The architectural model behind these flows lives in [Architecture](architecture.md); the command flag reference lives in [Commands](commands.md).

## Daily ops in the TUI

Run `agentsync` with no arguments for an interactive view of daemon health,
vault state, agent file deltas, and pending sync activity. The TUI keeps a
1.5-second poll on the daemon IPC `status` command, so the dashboard reflects
live state without you re-running `agentsync status`.

The flag-driven equivalents still work when you need scripted output:

- `agentsync status` — text comparison of local files vs the decrypted
  vault.
- `agentsync daemon status` — daemon health only.
- `agentsync doctor` — local environment, key, vault, and daemon checks.

## Daemon

The daemon is a long-running process that watches your enabled agent paths and pushes on change. It debounces rapid edits, serialises sync operations through a queue so two pushes can never race, and runs periodic pulls at a configurable interval.

### Install per OS

The CLI dispatches to the right backend automatically. The same command works on every platform:

```bash
agentsync daemon install   # write the OS service descriptor
agentsync daemon start     # idempotent
agentsync daemon status    # IPC ping; reports running state and last sync
```

To stop or remove:

```bash
agentsync daemon stop
agentsync daemon uninstall
```

The platform backend is selected at runtime:

| OS | Backend | Service location |
|---|---|---|
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/com.agentsync.daemon.plist` |
| Linux | systemd user unit | `~/.config/systemd/user/agentsync.service` |
| Windows | Task Scheduler | per-user scheduled task `AgentSyncDaemon` |

After `daemon install`, the OS supervisor restarts the daemon on user login and after a crash. `daemon start` brings it up immediately without waiting for the next login.

### Lifecycle

The daemon moves through a small number of phases. Each phase has a well-defined exit condition.

| Phase | Description |
|---|---|
| Validating | Verifies the vault directory, the config file, and the encryption key are reachable. Exits immediately on failure. |
| Second-instance check | Sends an IPC `status` ping. If a daemon is already running, exits. Unlinks a stale socket if the prior daemon died ungracefully. |
| Running | IPC server is listening. File watchers and the periodic pull timer are active. `status` returns the current pid, consecutive-failure counter, and last error. |
| Syncing | A push or pull is executing inside the sync queue. Only one sync runs at a time. |
| Retry once | Automatic single retry after a transient failure. If both attempts fail, the error is recorded but the daemon stays alive so the next change can still trigger a push. |
| Shutting down | Drains the sync queue with a hard ten-second timeout, closes IPC, stops watchers, unlinks the socket, exits cleanly. |

### Configuration

Daemon behaviour is driven by the `[sync]` table in `agentsync.toml`:

```toml
[sync]
debounceMs = 300        # quiet window after a file change before push fires; 50 to 10000
autoPush = true         # disable to make the daemon read-only
autoPull = true         # disable to opt out of periodic pull
pullIntervalMs = 300000 # how often periodic pull runs, in milliseconds; minimum 1000
```

Defaults are chosen so you can install and forget. Tune them only if you observe excessive push churn or want to widen the pull cadence. Values outside the supported range are rejected at config load.

### Logs

Inspect platform logs when `daemon status` reports unhealthy:

- macOS: `~/Library/Logs/agentsync.out.log` and `agentsync.err.log`, plus the LaunchAgent's `Console.app` entries.
- Linux: `journalctl --user -u agentsync.service`.
- Windows: Task Scheduler history for `AgentSyncDaemon`, plus the daemon's stdout file under the user's local app data.

## Key management

### Add a recipient

When a new machine joins the vault, run `init` on it, copy the public key it prints, and on an existing machine register it:

```bash
agentsync key add my-laptop age1...
```

The vault is reconciled against the remote, every existing artefact is re-encrypted for the updated recipient set, and the change is pushed. The new machine can then `pull`.

### Rotate the current machine key

Rotation re-encrypts every artefact under a fresh keypair on the current machine:

```bash
agentsync key rotate
```

Rotation requires the existing private key to still be readable, because every vault artefact must be decrypted before it can be re-encrypted under the new recipient. Back up the old key before rotation if you intend to retire the previous identity entirely.

### Recipient naming

Recipient names are stable config keys. Use machine names that describe the device clearly (`work-mbp`, `home-desktop`). Names are visible to anyone who can read the vault repository — they are not secret, but they should not encode anything you do not want associated with a public Git remote.

## Verifying release binaries

Every binary published to a [GitHub Release](https://github.com/chrisleekr/agentsync/releases/latest) ships with three complementary verification artefacts:

- A sibling `<binary>.sha256` file with the SHA256 checksum (per binary).
- A single `SHA256SUMS` manifest listing every binary's hash in one file (per release).
- A Sigstore-backed build provenance attestation generated by [`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance) and stored on GitHub (per binary).

### Check the checksum

Download the binary and its `.sha256` sibling, then run `shasum -a 256 -c`:

```bash
curl -L -o agentsync-linux-x64 \
  https://github.com/chrisleekr/agentsync/releases/latest/download/agentsync-linux-x64
curl -L -o agentsync-linux-x64.sha256 \
  https://github.com/chrisleekr/agentsync/releases/latest/download/agentsync-linux-x64.sha256
shasum -a 256 -c agentsync-linux-x64.sha256
```

A line ending in `OK` means the bytes you downloaded match the bytes the release job hashed. Anything else aborts the install. The `.sha256` file lists the binary by its release filename, so keep the downloaded filename unchanged (or update the first column of the `.sha256` to whatever you renamed it to) before running `-c`.

Windows ships neither `shasum` nor `sha256sum` by default. Use PowerShell's `Get-FileHash` and compare against the first column of the downloaded `.sha256` file:

```powershell
$expected = (Get-Content agentsync-windows-x64.exe.sha256).Split(' ')[0]
$actual   = (Get-FileHash agentsync-windows-x64.exe -Algorithm SHA256).Hash.ToLower()
if ($expected -eq $actual) { "OK" } else { throw "checksum mismatch" }
```

In a CI script that needs a non-zero exit on mismatch, replace `throw` with `Write-Error 'checksum mismatch'; exit 1` so the host shell sees the failure regardless of `$ErrorActionPreference`.

### Bulk-verify with the aggregate SHA256SUMS

Downstream packagers (Scoop, Chocolatey, Homebrew, Ansible roles) that pin a single URL per release prefer the aggregate `SHA256SUMS` manifest, which lists one `<hash>  <binary>` line per arch:

```bash
curl -L -o SHA256SUMS \
  https://github.com/chrisleekr/agentsync/releases/latest/download/SHA256SUMS
shasum -a 256 -c --ignore-missing SHA256SUMS
```

`--ignore-missing` skips lines whose binary is absent from the current working directory, so the same manifest works whether you downloaded one arch or all five. Per-binary `.sha256` siblings remain the recommended path for end-user one-off installs; the aggregate manifest exists for tooling.

The bulk recipe is POSIX-shell only — Windows packagers (Scoop, Chocolatey) run their verify step on Linux/macOS CI in practice. A Windows end user who downloads the aggregate manifest can either run it under WSL or Git-Bash, or fall back to the per-binary `Get-FileHash` recipe above.

### Verify build provenance

The attestation proves the binary was produced by this repository's `release-please` workflow at the tagged commit. Verify it with the GitHub CLI:

```bash
gh attestation verify agentsync-linux-x64 --repo chrisleekr/agentsync
```

A passing verification reports the workflow path, commit SHA, and Sigstore transparency log entry. Failure means the binary was not produced by this repository's release pipeline; do not run it. Pin the verification to `--repo` (not `--owner`) so an attestation minted by any other repository under the same owner is rejected.

Both checks are independent. The checksum protects against transport corruption and mirror tampering; the attestation protects against a substituted binary that happens to carry a forged checksum. Run both on first install of every release, and repeat the pair for each platform binary you download — every job in the release matrix mints its own attestation.

### Windows SmartScreen on first run

The first time you launch `agentsync-windows-x64.exe`, Windows will display *"Windows protected your PC"* with the body text *"Microsoft Defender SmartScreen prevented an unrecognized app from starting. Running this app might put your PC at risk."* It refuses to run until you click **More info** → **Run anyway**. This happens because the binary is not signed with an [Authenticode](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/authenticode) code-signing certificate. Since the CA/B Forum 2023 ruling, every code-signing cert (OV or EV) requires HSM-backed key storage, so the practical floor is a few hundred dollars per year plus ongoing key-management overhead.

This project relies on the [Sigstore-backed build provenance attestation](#verify-build-provenance) as its trust path instead. If `gh attestation verify agentsync-windows-x64.exe --repo chrisleekr/agentsync` passes against the binary you downloaded, the bytes were produced by this repository's `release-please` workflow at the tagged commit — the SmartScreen warning is a UX consequence of the missing Authenticode cert, not a signal that the binary is unsafe. Click through it once per binary update.

SmartScreen reputation is per-binary-hash and accrues with downloads; every new release starts from zero, so the warning recurs on each update.

## Recovery runbooks

### Recover from divergence

Reconciliation is fast-forward only. Any command that touches the vault (`init`, `push`, `pull`, `key add`, `key rotate`) fails closed when local history has diverged from `origin/<branch>`.

Symptoms:

- The command reports that AgentSync only supports fast-forward sync.
- It prints a recovery hint telling you to reset or reclone the vault.
- `pull` stops without printing `Pull completed: ...`.

Steps:

1. Back up any local-only vault changes you still need (rare, but possible if you have edited the vault repository directly).
2. Confirm which branch is the source of truth on the remote.
3. Reset the local vault to that branch, or remove the local vault directory and run `init` again.
4. Re-run the original command only after the local vault matches the remote history.

Do not resolve this with `git merge` or `git rebase`. AgentSync intentionally fails closed so every machine uses the same reconciliation model.

### Recover a missing private key

If `pull` cannot decrypt or `doctor` reports a missing key:

1. Confirm the expected key path with `agentsync doctor`.
2. Restore the backed-up private key file.
3. Ensure permissions are restrictive: on Unix, `chmod 600 ~/.config/agentsync/key.txt`.

If the key is gone and was never backed up, the vault cannot be recovered for that machine. Generate a new identity with `init`, have the new public key added by an existing machine, then `pull`.

### Reset a vault

When you want to throw away vault state and start over, reach for
[`agentsync destroy`](commands.md#destroy) rather than `rm -rf`.

> **Agent files are never touched.** Every `agentsync destroy` scope
> leaves `~/.claude/`, `~/.cursor/`, `~/.codex/`, `~/.copilot/`, and your
> VS Code user directory byte-for-byte unchanged. This is guaranteed by
> code and asserted by test — `destroy` only ever operates on the vault
> directory and the configured remote.

Decide the scope first:

- **Local clone is corrupted, remote is fine** → `agentsync destroy`
  (default `--scope=local`). Removes `~/.agentsync/vault/`, keeps
  `key.txt`. Then re-init from the same remote.
- **You want every machine to start fresh, including the remote** →
  `agentsync destroy --scope=remote`. Adds a commit to the remote that
  removes every tracked file (not a force-push — history is preserved
  and other recipients can `git revert` if they still have a copy).
- **Both** → `agentsync destroy --scope=all`. Remote is wiped first so a
  failed push does not leave you with a wiped local that cannot reach
  the remote.

Before running, back the vault up if you might still want it:

```bash
cp -r ~/.agentsync/vault ~/.agentsync/vault.bak.$(date +%s)
```

Three confirmation gates must pass: preview prompt → typed phrase
(`DESTROY` for local, `DESTROY <branch>@<remote-fragment>` for remote /
all) → final y/n. The command refuses to run in a non-TTY shell without
`--yes`. See [Commands → destroy](commands.md#destroy) for the full flag
and behaviour reference.

## Troubleshooting catalogue

### `status` shows local-only or vault-only entries

- `local-only` means the machine has config that is not in the vault yet. Run `push` after reviewing the content.
- `vault-only` means the vault has artefacts this machine did not snapshot locally. Run `pull` if the content should exist on this machine.

### Push aborts because secrets were detected

The sanitiser found literal tokens or credentials in content that would otherwise be encrypted and committed. Sanitiser hits are intentionally a hard stop — they prevent the agent from leaking a secret into the vault, where it would persist even after subsequent pushes.

Fix:

1. Remove the literal secret from the local config.
2. Replace it with the agent's supported secret reference, environment variable, or login flow.
3. Run `push` again.

Do not bypass this by editing the vault manually.

### Daemon is not running

Check, in order:

1. The service is installed for the current platform (`daemon install` writes the descriptor).
2. The OS supervisor reports the service as active (`launchctl list`, `systemctl --user status agentsync`, or Task Scheduler).
3. `daemon status` can reach the local IPC endpoint.

If the service is installed but `daemon status` cannot reach it, inspect the platform logs listed above.

### A skill I deleted reappears after pull on another machine

Working as designed. `pull` is additive: it never removes a local skill directory, even when the matching vault file is gone. The safety reasoning is that a concurrent edit on machine B should not silently vanish after machine A removes a skill.

Two cases:

- **Whole-skill removal**: run `agentsync skill remove <agent> <name>` on one machine to remove the vault entry, then delete the local directory on every other machine manually:

    ```bash
    rm -rf ~/.claude/skills/<name>     # or ~/.cursor/skills, ~/.codex/skills, ~/.copilot/skills
    ```

- **Single file inside a skill**: pull never propagates deletions, so a removed `helper.md` survives on machines that previously had it. Delete the stale file manually on each machine, then `status` to confirm.

A future release may offer `pull --replace-skills` for users who want vault-as-source-of-truth overwrite semantics, but the default will remain additive.

### Private key missing or unreadable

See [Recover a missing private key](#recover-a-missing-private-key) above.

### Doctor reports a sensitive file in the vault

The vault scan found something that looks like an unencrypted secret inside the cloned vault repository. This should never happen under normal operation because the sanitiser runs before encryption.

Steps:

1. Stop using the vault until the cause is understood. Do not push.
2. Inspect the offending file. If it is in fact encrypted (`.age` suffix and binary contents) the warning is a false positive; report it.
3. If it is plaintext, find which push wrote it (`git log` inside the vault) and rotate any leaked credential immediately.
4. Once mitigated, reclone the vault, re-init, and push.

### Vault clone is reachable but `init` fails

Common causes:

- The remote URL has a typo (a URL without `:` or `/` is rejected immediately).
- The remote **repository** does not exist on the host yet. `init` creates the branch via `--set-upstream` on first push, but it cannot create the repository itself.
- Git authentication is not set up for the remote. AgentSync uses your existing Git credentials.

Run `agentsync doctor` for a focused report, then re-run `init`.

### TUI does not open / falls back to text output

Bare `agentsync` deliberately falls back to printing `status` output when
stdout is not a TTY. This happens under `nohup`, inside `script(1)`, when
piped to another process, or in CI runners. Force the TUI from a
non-interactive context by running `agentsync tui` with a real terminal
allocated by the shell (e.g. `script -q /dev/null agentsync tui`); the
fallback exists specifically to protect scripts that depend on text output.

### Terminal looks broken after the TUI crashed

The TUI installs SIGINT / SIGTERM / exit handlers that restore the terminal
on shutdown. A hard kill (`kill -9` on the bun process) can bypass that and
leave the terminal in raw mode. Recover with:

```bash
reset
# or, if `reset` is unavailable:
tput reset
```

### `dist/agentsync` exits 137 on macOS

This is the macOS Gatekeeper killing the unsigned compiled binary on first
launch. It is a pre-existing issue with the compiled distribution and is
not caused by the TUI dependency. The supported install method is `bun
install -g @chrisleekr/agentsync`, which ships the bundled `dist/cli.js`
through Bun and is not subject to Gatekeeper. Code signing for the
compiled binary is tracked separately from the TUI work.
