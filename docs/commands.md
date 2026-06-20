---
description: Complete AgentSync CLI reference: every command, flag, default, and caveat for init, push, copy, status, daemon, key, skill, plugin, vault, and the TUI.
---

# Commands

Every AgentSync subcommand in one reference: what it does, what it needs, what it produces, and the caveats that bite if you ignore them.

## What this page owns

This page owns the command contract. It documents every flag, every default, every exit condition. It does not document *how* the command works internally — that lives in [Architecture](architecture.md) and is referenced where the contract depends on it.

## Install paths

Every example below uses the globally installed binary:

```bash
bun install -g @chrisleekr/agentsync
agentsync <command> [options]
```

The same commands work through `bunx` without a global install:

```bash
bunx --package @chrisleekr/agentsync agentsync <command> [options]
```

When developing from source, replace the binary call with `bun run src/cli.ts`. The flags are identical.

## Two ways to use agentsync

- **Interactive**: run `agentsync` (no subcommand) to open the [TUI](#tui). It
  is the right entry point for everyday browsing, sync, and migration.
- **Scripted**: every subcommand below runs unchanged from a shell, CI, or a
  wrapper script. Bare `agentsync` in a non-TTY context falls back to
  `status` text output so existing pipelines are not affected.

## Command index

| Command | Purpose |
|---|---|
| [*(bare)* / `tui`](#tui) | Open the interactive tab-based TUI. |
| [`init`](#init) | Bootstrap the vault, machine key, and config. |
| [`push`](#push) | Snapshot, sanitise, encrypt, and fast-forward this machine's namespace to the vault. |
| [`copy`](#copy) | Apply an artefact (or subdir) from a machine's vault namespace to local disk (`copy self …` for your own). |
| [`ls`](#ls) | List machine namespaces, or the copyable artifact paths in one. |
| [`status`](#status) | Compare local snapshot to decrypted vault state (any machine via `--machine`). |
| [`doctor`](#doctor) | Check the local environment before blaming sync logic. |
| [`daemon`](#daemon) | Install, start, stop, and inspect the background daemon. |
| [`key`](#key) | Add, list, or remove recipients, or rotate the current machine key. |
| [`config`](#config) | View or change vault config (agents, sync, security policy). |
| [`skill`](#skill) | Remove a skill from the vault. |
| [`plugin`](#plugin) | List or reinstall a machine's Claude plugins from its vault manifest. |
| [`vault`](#vault) | Migrate an older vault to the current format (`vault upgrade`). |
| [`migrate`](#migrate) | Translate configuration between agent formats. |
| [`destroy`](#destroy) | Wipe the local vault clone or the remote vault contents (via commit). |
| [`upgrade`](#upgrade) | Check GitHub for a newer release and install it when possible. |

## tui

**Why**: Browse the vault, inspect what each local agent has on disk, trigger
a push, browse other machines and copy their config to this one, and run
cross-agent migrations from a single interactive screen.

**Usage**:

```bash
agentsync           # bare invocation opens the TUI on a real terminal
agentsync tui       # explicit alias, same behaviour
```

**Tabs**:

| Tab | What it shows |
|---|---|
| 1 Dashboard | Daemon health (pid, uptime, **last successful sync**, last error, and a loud **stuck** warning when the vault diverged), vault state, agent summary, init / key-rotate launchers. |
| 2 Sync | Per-artifact rows grouped by sync status (`local-changed`, `local-only`, `vault-only`, `unknown`, `synced`). Multi-select with `space`; push selected with `p`; bulk-remove any selected vault artifacts with `x` (y/n confirm) — rows with no vault copy (`local-only`) are ignored. Enter on a skill drills into its files with per-file diff. |
| 3 Machines | The vault's `machines/<name>/` namespaces. Move with `↑`/`↓`; `enter` copies the selected machine's config to this machine (the same `performCopy` core as the CLI; never touches the vault). |
| 4 Migrate | From / To / Type form (To and Type are multi-select with sub-cursor). Preview is mandatory before Apply enables. |
| 5 Activity | Session-only ring buffer of TUI actions. |
| 6 Config | View and change vault config (agents enabled, `sync.*`, `claudePlugins.*`, `security.*`) with `↑`/`↓` to move, `space` to toggle a boolean, `←`/`→` to cycle an enum or adjust a number. Writes go through the same [`config`](#config) core (reconcile + commit + push). Also lists the recipients who can decrypt the vault, read-only. |

**Global keys** (any tab):

| Key | Action |
|---|---|
| `1` – `6` | Jump to tab |
| `Tab` / `Shift-Tab` | Cycle tabs |
| `p` | Push vault (honours selection in the Sync tab as a per-file allowlist) |
| `r` | Refresh current tab |
| `?` | Toggle the keymap overlay |
| `q` / `Ctrl-C` | Quit, restoring the terminal |

**Outcome**: every state change is additive on the same data the CLI
subcommands operate on. Push goes through the same daemon IPC the `status` and
`daemon` subcommands use; the Machines tab calls the same `performCopy` core as
`agentsync copy`; migrate calls the same planner as `agentsync migrate`; bulk
removal calls the same `performVaultRemove` core that `agentsync skill remove`
delegates to, once per selected vault artifact; the Config tab writes through
the same `performConfigSet` core as `agentsync config set`.

**Caveats**:

- The TUI is interactive-only. In a non-TTY context (piped stdin/stdout,
  `nohup`, CI runners) bare `agentsync` deliberately falls back to text
  `status` output so existing scripts continue to work.
- The activity log is session-scoped — closing the TUI discards history.
- Push requires the daemon to be running. If the daemon is offline, the footer
  shows `daemon ● offline` and `p` surfaces an inline notice rather than
  queueing a request that cannot be served. (Copy runs in-process and does not
  need the daemon.)

## Conventions

- **Why** — when to reach for this command.
- **Usage** — the typical invocation.
- **Flags** — supported options.
- **Outcome** — what the filesystem and the vault look like afterwards.
- **Caveats** — non-obvious behaviour. Read these.

## init

**Why**: Create the local vault workspace, the machine's age keypair, `agentsync.toml`, and the initial Git wiring to the vault remote.

**Usage**:

```bash
agentsync init --remote git@github.com:<you>/agentsync-vault.git --branch main
```

**Flags**:

| Flag | Default | Description |
|---|---|---|
| `--remote` | required | Git remote URL for the vault. |
| `--branch` | `main` | Branch in the vault remote that this machine tracks. |

**Outcome**: a local vault directory exists, the machine's recipient is registered in `agentsync.toml`, and AgentSync either creates the first remote commit (empty-branch bootstrap) or joins the existing remote history before writing machine-specific changes.

**Caveats**:

- If the remote branch does not yet exist, `init` creates it via `git push --set-upstream` on the first commit. The remote **repository** itself must already exist on the host; `init` does not create the repo for you.
- An empty remote branch is treated as first-machine bootstrap. An existing remote branch is joined.
- If the local vault already diverged from the configured remote branch, `init` stops with a recovery error rather than pushing a local-first history. See [Recover from divergence](operations.md#recover-from-divergence).
- The generated private key must be backed up outside the vault. The vault cannot decrypt it for you if the key is lost.

## push

**Why**: Snapshot the enabled agents' local configuration, run the sanitiser, encrypt, and fast-forward the result to the vault remote.

**Usage**:

```bash
agentsync push
agentsync push --agent claude
agentsync push --dry-run
```

**Flags**:

| Flag | Default | Description |
|---|---|---|
| `--agent` | all enabled | Restrict to one agent (`claude`, `cursor`, `codex`, `copilot`, `vscode`). |
| `--message` | auto | Custom commit message for the vault commit. |
| `--dry-run` | `false` | Show actions and previews without writing or pushing. |

**Outcome**: every changed artefact for the targeted agent(s) is encrypted and committed to the vault, then fast-forward-pushed to the remote. The vault commit message names the agent(s) and the machine.

**Caveats**:

- Push is **additive**: deleting a skill locally does not remove it from the vault. Use [`skill remove`](#skill) for explicit removal.
- The sanitiser is a hard gate. Literal secrets or never-sync paths abort the entire push before bytes leave the machine. See [Push aborts because secrets were detected](operations.md#push-aborts-because-secrets-were-detected).
- Reconciliation is fast-forward only. Divergence aborts the push with recovery guidance.
- `--dry-run` exercises the snapshot, sanitiser, and encryption pipeline so previews reflect what would actually be written.

## copy

**Why**: Restore an artifact (or a whole subdir) from any machine's vault namespace onto local disk. In v2 the vault is push-only backup, so `copy` is the only vault→local path. `copy self <path>` restores your own machine's backup.

**Usage**:

```bash
agentsync copy work-laptop claude/CLAUDE.md.age   # from another machine's namespace
agentsync copy self claude/skills/                # restore your own skills subdir
agentsync copy work-laptop claude/ --dry-run      # preview the whole claude namespace
```

**Arguments**:

| Argument | Description |
|---|---|
| `<machine>` | Source machine namespace under `machines/`, or `self` for this machine. |
| `<path>` | Logical vault path: a single artifact (`claude/CLAUDE.md.age`) or a subdir prefix (`claude/skills/`) to copy every artifact beneath it. |
| `--dry-run` | Preview each artifact without writing locally. |

**Outcome**: the named artifacts are decrypted with the local key (encryption is to all recipients) and applied to local agent paths using the same handlers, JSONC merge, and `.bak` backups as a full restore. `copy` writes only to local disk — it never writes this machine's vault namespace; the next `push` captures the change normally. An unknown machine lists the available namespaces; a missing artifact reports the path.

**Caveats**:

- `copy` is **additive**: it applies what the source has and never deletes a local file the source omits.
- Reconciliation is fast-forward only.
- Plugins are not copyable via `copy` — they are reinstalled from the recorded manifest by `plugin install`.

## ls

**Why**: Discover what is in the vault before you `copy`. `copy` needs an exact logical path (e.g. `claude/CLAUDE.md.age`); `ls` is how you find those paths — especially on a fresh machine where you do not yet know another machine's layout.

**Usage**:

```bash
agentsync ls                       # list every machine namespace in the vault
agentsync ls work-laptop           # list the copyable artifacts in that namespace
agentsync ls work-laptop claude/   # narrow to a path prefix
agentsync ls self                  # browse this machine's own backup
```

**Arguments**:

| Argument | Description |
|---|---|
| `<machine>` | Machine namespace to browse, or `self`. Omit to list all machines. |
| `<path>` | Optional path prefix to narrow the listing. |

**Outcome**: with no argument, the machine namespaces under `machines/`. With a machine, the logical `.age` paths you can hand to `copy <machine> <path>`. **Read-only and key-free** — it lists which encrypted files exist without decrypting them, so a machine that is not yet a recipient can still discover what is copyable. It reconciles fast-forward first so the listing reflects the latest backup.

## status

**Why**: Compare the local snapshot to the decrypted vault state for the enabled agents — this machine's own backup by default, or another machine's via `--machine` to preview a `copy`.

**Usage**:

```bash
agentsync status
agentsync status --verbose
agentsync status --machine work-laptop   # diff local config against another machine's backup
```

**Flags**:

| Flag | Default | Description |
|---|---|---|
| `--verbose` | `false` | Show per-file hashes alongside each row. |
| `--machine` | this machine | Compare against another machine's namespace (or `self`). Needs the private key to decrypt; an unknown name lists the available machines. |

**Outcome**: a per-agent report covering every enabled agent. Each row carries one of the following status strings, printed verbatim:

- `synced` — local content matches the vault.
- `local-changed` — both sides have the file but the content differs. Run `push` to publish the local copy, or `copy self <path>` to restore the vault copy after backing up the local one.
- `local-only` — the machine has content the vault does not. Run `push`.
- `vault-only` — the source namespace has content the local disk does not. Run `copy <machine> <path>` (or `copy self <path>` when comparing against `self`) to bring it down.
- `unknown` — the private key was unavailable, so the vault row could not be decrypted and the comparison is inconclusive. Restore the key and re-run.
- `error` — snapshot or decryption failed for that row. The error detail is printed in the same row; address it before trusting the rest of the report.

**Caveats**:

- `status` is read-only. It never mutates the vault or local files.
- Vault-only entries marked "not on this machine" are normal when another machine snapshots an agent this machine does not enable.
- `--machine` compares only the agents **this** machine has enabled. To browse another machine's full namespace (including agents you have disabled), use [`ls`](#ls).

## doctor

**Why**: Check the local environment before blaming sync logic. A clean `doctor` is the precondition for filing a bug.

**Usage**:

```bash
agentsync doctor
```

**Outcome**: a report covering:

- private key presence and permissions,
- config parseability,
- age-encryption module availability,
- remote reachability,
- obvious unencrypted sensitive files in the vault,
- readability of the per-agent skills directories (`buildSkillsDirChecks` warns if a directory is missing, unreadable, a symbolic link, or exists but is not a directory),
- daemon service installation state.

**Caveats**:

- `doctor` does not fix anything. It surfaces the failure mode so you can choose the right runbook in [Operations](operations.md).
- A `doctor` warning about a sensitive file in the vault is always serious. See [Doctor reports a sensitive file in the vault](operations.md#doctor-reports-a-sensitive-file-in-the-vault).

## upgrade

**Why**: Stay on the latest release without leaving the tool. `upgrade` asks GitHub for the newest published version and, when it can, installs it for you.

**Usage**:

```bash
agentsync upgrade          # check, then install if a newer version exists
agentsync upgrade --check  # report only, install nothing
```

**Outcome**: depends on how agentsync was installed:

| Install method | What `upgrade` does |
|---|---|
| `bun install -g @chrisleekr/agentsync` | Reinstalls the package globally at the latest version. Restart agentsync to run the new code. |
| Standalone binary | Prints the releases page — a running binary cannot replace its own file. Download and verify the new binary against `SHA256SUMS` yourself. See [Verifying release binaries](operations.md#verifying-release-binaries). |
| `bunx` | Nothing to do — `bunx` fetches the latest on every run. |

**Caveats**:

- The check calls the GitHub releases API. Offline or rate-limited, it fails quietly and reports that it could not check (exit code 1).
- The TUI Dashboard runs the same check in the background and shows an `Update available` banner; press `u` there to upgrade a global install.
- The result is cached for 24 hours at `~/.config/agentsync/update-check.json` (`%APPDATA%/agentsync` on Windows). `agentsync upgrade` always re-checks and ignores the cache.

## daemon

**Why**: Run AgentSync as a background process that watches your agent paths and debounces pushes on change. It is push-only and does not auto-pull.

**Usage**:

```bash
agentsync daemon install     # write the OS service descriptor
agentsync daemon start       # idempotent
agentsync daemon status      # last-sync health (last success, failures, stuck)
agentsync daemon stop
agentsync daemon uninstall
```

**Outcome**: a long-running process supervised by launchd (macOS), systemd-user (Linux), or Task Scheduler (Windows). The daemon serialises sync operations through an internal queue so no two operations race.

**Caveats**:

- Only one daemon runs per user. A second-instance check exits cleanly if a daemon is already up.
- A transient sync failure triggers one automatic retry. If the retry also fails, the error is recorded but the daemon stays alive so the next change can trigger a fresh push.
- `daemon status` reports the last successful sync time, consecutive failures, and a **stuck** flag (vault diverged). When the daemon is **not** running it falls back to the durable `daemon-state.json`, so you still see when sync last succeeded. `doctor` surfaces a stale or stuck last-sync as a dedicated health row — a silent backup failure is loud, not invisible.
- See [Daemon](operations.md#daemon) for install paths per OS, lifecycle, health/durable-state, and log locations.

## key

**Why**: Manage who can decrypt the vault — add a recipient, list recipients, deauthorize (remove) one, or rotate the current machine's keypair.

**Usage**:

```bash
agentsync key add <name> <age-public-key>   # authorize a recipient
agentsync key list                           # audit who can decrypt the vault
agentsync key remove <name>                  # deauthorize a recipient
agentsync key rotate                         # new local identity, re-encrypt
```

**Outcome**: `add`, `remove`, and `rotate` decrypt every existing vault artefact under the current key and re-encrypt it under the updated recipient set, then commit and push. `list` is read-only — it prints each recipient alias and public key from `agentsync.toml`, marking the entry that belongs to this machine with `*`.

**Caveats**:

- `key add`, `key remove`, and `key rotate` reconcile against the latest remote state before they rewrite encrypted vault content.
- If the vault history has diverged, key-management commands stop until the vault is reset or recloned. See [Recover from divergence](operations.md#recover-from-divergence).
- Rotation depends on the **old** private key still being available so existing vault files can be decrypted. Back up the old key before rotation if you intend to retire that identity entirely. Rotation is crash-safe: it re-encrypts to both the old and new key, swaps the key file atomically, then drops the old recipient, so an interrupted rotation never leaves a vault no on-disk key can read.
- `key remove` re-encrypts forward for the remaining recipients, so the removed key can no longer read **future** pushes. It **cannot** retro-purge git history: a removed key still decrypts the vault state already on the remote. For true revocation of a lost machine, also rotate any secrets it could read. See [Deauthorize a lost machine](operations.md#deauthorize-a-lost-machine).
- `key remove` refuses to remove the only remaining recipient (a vault must stay decryptable) and refuses to remove the key of the machine you run it on (you cannot deauthorize yourself — run it from another machine to remove a lost one).
- Recipient names are stable config keys and are visible in the vault repository. Use names that describe the machine clearly without leaking sensitive context.

## config

**Why**: View or change the vault configuration in `agentsync.toml` without hand-editing it — which agents are enabled, daemon sync behaviour, and the secret-handling policy.

**Usage**:

```bash
agentsync config list                              # print every configurable key
agentsync config get sync.debounceMs               # read one value
agentsync config set agents.vscode true            # enable VS Code sync
agentsync config set security.secretScan strict    # widen secret detection
agentsync config set security.allowSecretValues '["AKIA-not-a-real-key"]'
```

**Settable keys** (dotted paths under these sections):

| Key | Type | Meaning |
|---|---|---|
| `agents.<claude\|cursor\|codex\|copilot\|vscode>` | boolean | Whether that agent is snapshotted on push. |
| `sync.debounceMs` | integer 50–10000 | Daemon quiet-window before an auto-push. |
| `sync.autoPush` | boolean | Whether the daemon auto-pushes on change. |
| `claudePlugins.syncPlugins` | boolean | Record the Claude plugin reinstall manifest on push. |
| `security.secretScan` | `standard`\|`strict`\|`off` | Push-time secret-scan mode. `standard` = built-in credential patterns; `strict` also flags JWTs; `off` disables the artefact-body scan. |
| `security.allowSecretValues` | string[] (JSON) | Literal values exempt from secret detection and base64 redaction. |
| `security.redactBase64Values` | boolean | When `true` (default), redact long base64-looking JSON values; set `false` if a config legitimately stores base64 that must round-trip. |

> **What the secret scan is — and is not.** It matches a fixed set of
> high-precision **credential formats** (vendor API-key prefixes, AWS/GitHub/GitLab/Slack/Google
> tokens, age identities, PEM private-key headers; `strict` adds JWTs). It is
> **not** a general secret scanner — a plain password, a bespoke token, or a
> connection string with no recognised shape passes through. Encryption is the
> real protection; the scan only stops well-known credentials from entering git
> history. `off` disables the artefact-body scan, but **skill-bundle interiors
> are always scanned at `standard`** as a fail-safe. `agentsync.toml` itself is
> committed in **plaintext**, so `allowSecretValues` is for exempting legitimate
> high-entropy *non-secret* values — never paste a real credential there.
> `config set` refuses to store a recognised credential in any key other than
> `security.allowSecretValues`.
> See [Push aborts because secrets were detected](operations.md#push-aborts-because-secrets-were-detected).

**Outcome**: `list` and `get` are read-only. `set` validates the new value against the full config schema (so an out-of-range debounce or an invalid enum is rejected before anything is written), then — because `agentsync.toml` is shared across machines — reconciles fast-forward, commits, and pushes the change, exactly like `key add`.

**Caveats**:

- `version`, `recipients`, and `remote` are **not** settable here. Recipients are managed by [`key`](#key); the remote is fixed at [`init`](#init); the format version is the old-binary guard.
- A value is parsed as JSON first (`true`, `500`, `["x"]`), falling back to a plain string for bare words (`strict`). Quote a JSON array in your shell.
- `set` reconciles against the remote first, so it fails closed on diverged history like every other vault-writing command.

## skill

**Why**: Remove a skill from the vault without affecting the rest of the snapshot. This is AgentSync's only explicit, non-additive operation.

**Usage**:

```bash
agentsync skill remove <agent> <name>
agentsync skill remove <agent> <name> --machine <namespace>
```

**Flags**:

| Flag | Default | Description |
|---|---|---|
| `--machine` | this machine | Remove from another machine's `machines/<name>/` namespace. Validated against the same path-traversal rules as the resolved machine name. |

**Outcome**: the vault artefact for that skill is deleted, the change is committed and pushed under the fast-forward reconciliation rule. The local skill directory on the current machine is left untouched.

**Caveats**:

- `skill remove` is the **only** non-additive operation in AgentSync. It deletes the vault artefact but does not remove the local skill directory on the current or other machines.
- After `skill remove`, every machine that copied the skill previously still has the local directory until you delete it manually there. See [A skill I deleted reappears after copy on another machine](operations.md#a-skill-i-deleted-reappears-after-copy-on-another-machine).
- To snapshot a single agent's skills, use `push --agent <agent>`; to bring one machine's skills onto this one, use `copy <machine> <agent>/skills/`. There is no targeted `skill push`/`skill copy`; the snapshot for an agent always includes every skill that survives the walker contract.

## plugin

**Why**: Reproduce a machine's Claude plugins on another machine. AgentSync does not encrypt the plugin tree; the marketplace is the source of truth. `push` (with `[claudePlugins] syncPlugins = true`) records a distilled manifest — each plugin's `name@marketplace`, scope, and enabled flag — and `plugin install` reinstalls from it via the local `claude` CLI.

**Usage**:

```bash
agentsync plugin list <machine>            # print the recorded manifest
agentsync plugin install <machine> [name]  # reinstall all, or one named plugin
```

Use `self` as `<machine>` to act on this machine's own manifest.

**Outcome**: `install` registers each referenced marketplace (`claude plugin marketplace add`), installs each plugin at its recorded scope (`claude plugin install <name>@<marketplace> -s <scope>`), then enables or disables it to match the manifest.

**Caveats**:

- Requires the `claude` CLI on `PATH`; a missing binary fails loudly rather than skipping silently.
- Reinstall fetches the **latest** version — there is no version pin.
- Local edits to plugin files are not preserved; only the manifest (marketplace + name + scope + enabled) round-trips.

## vault

**Why**: Migrate an older flat (v1) vault to the per-machine layout (v2), where every artefact lives under `machines/<name>/`. This is the vault-**format** migration — distinct from [`migrate`](#migrate), which translates config between agents, and from [`upgrade`](#upgrade), which updates the AgentSync binary.

**Usage**:

```bash
agentsync vault upgrade
```

**Outcome**: the existing flat content is assumed to belong to this machine and is `git mv`'d under `machines/<this-machine>/`, the config `version` is bumped to the integer `2`, and the change is committed and fast-forwarded to the remote. It reconciles first, so a vault another machine already upgraded is detected and the command is a no-op. Idempotent — running it on a v2 vault prints "already at format v2".

**Caveats**:

- If the vault format is **newer** than this binary understands, the upgrade refuses and tells you to run `agentsync upgrade` to update AgentSync first.
- Old (v1) binaries cannot read a v2 vault at all: `version` is an integer literal, and their string-typed schema rejects it. This is deliberate — it stops an old binary writing flat directories beside `machines/`.

## migrate

**Why**: Translate configuration between Claude, Cursor, Codex, Copilot, and VS Code without touching the vault.

**Usage**:

```bash
agentsync migrate --from <agent> --to <agent|all> [--type <type>] [--name <file>] [--dry-run]
```

**Flags**:

| Flag | Required | Values | Description |
|---|---|---|---|
| `--from` | yes | claude, cursor, codex, copilot, vscode | Source agent. |
| `--to` | yes | claude, cursor, codex, copilot, vscode, all | Target agent(s). |
| `--type` | no | global-rules, mcp, commands, skills, rules | Filter to one config type. |
| `--name` | no | artefact name | Migrate a single artefact (file or skill/rules directory). Requires `--type`. Hard-errors if not found. |
| `--dry-run` | no | — | Preview without writing. |

**Outcome**: the source agent's matching configuration is translated through the format-specific translators and written to the target agent's config location on disk. The vault is not touched.

**Caveats**:

- `migrate` operates on **local files only**. No vault initialisation is required.
- See [Migrate](migrate.md) for the full support matrix per config type, MCP transport translation rules, and per-agent quirks.

## destroy

**Why**: Reset vault state when you want to start over — either by removing
the local clone (`--scope=local`), wiping the remote contents via a normal
commit (`--scope=remote`), or both (`--scope=all`).

> **Agent files are never touched.** `agentsync destroy` does not read,
> modify, or delete a single byte under `~/.claude/`, `~/.cursor/`,
> `~/.codex/`, `~/.copilot/`, or your VS Code user directory, regardless
> of scope. This guarantee is enforced by code (no `AgentPaths.*` import
> in `src/commands/destroy.ts`) and by test (three sha256+mtime
> invariants in `destroy.test.ts`).

**Usage**:

```bash
agentsync destroy                       # local-only, default
agentsync destroy --scope=remote        # wipe remote via commit
agentsync destroy --scope=all           # both
```

**Flags**:

| Flag | Default | Description |
|---|---|---|
| `--scope` | `local` | One of `local`, `remote`, `all`. `local` removes the local vault dir. `remote` pushes a commit that `git rm -rf`s every tracked file on the remote — not a force-push, so history stays intact and `git revert` recovers the data on machines that still have it. `all` does both, remote first. |
| `--force` | `false` | Bypass the agentsync.toml safety check. Use when destroying a half-initialised vault that never got a config file written. Does **not** bypass the three confirmation gates. |
| `--yes` | `false` | Skip all three confirmation gates. Intended for scripted use; the command otherwise requires an interactive TTY. |

**Confirmation gates** (when `--yes` is not passed):

1. **Preview** — prints the exact paths that will be removed and lists
   every category of file that will **not** be touched (including local
   agent installations). Press `y` to advance, anything else to abort.
2. **Typed phrase** — type the exact string the preview tells you to:
   - `--scope=local`: type `DESTROY`.
   - `--scope=remote` / `--scope=all`: type `DESTROY <branch>@<remote-fragment>`,
     where the fragment is the last two path segments of the remote URL
     (e.g. `DESTROY main@chrisleekr/agentsync-vault`). This forces you to
     read the remote URL off the preview before you can confirm.
3. **Final y/n** — last chance. Anything other than `y` aborts.

**Outcome**:

| Scope | After destroy |
|---|---|
| `local` | `~/.config/agentsync/vault/` (or `%APPDATA%/agentsync/vault/` on Windows) is gone. `~/.config/agentsync/key.txt`, the daemon, the remote, and every `~/.<agent>/` directory are unchanged. Re-init from the same remote restores the clone. |
| `remote` | Remote branch has a new commit, `destroy: clear vault content`, that removes every previously-tracked file. Local vault dir keeps its `.git/` history. Other machines that still have the data can `git revert <sha>` to recover. |
| `all` | Both of the above. Remote is wiped first so a failed push does not leave you with a wiped local that cannot reach the remote. |

**Caveats**:

- Other recipients are affected by `--scope=remote` / `--scope=all`. Their
  next `agentsync push` or `copy` will reconcile against an empty vault and
  they lose their `agentsync.toml` config — they will need to re-init.
- The daemon stays running after a local destroy. Its next sync attempt
  will fail until re-init. Run `agentsync daemon stop` if you want it
  quiet in the meantime.
- `key.txt` is preserved across every scope. Re-init from the same remote
  reuses the existing identity so you stay a recipient. Delete the key
  manually (`rm ~/.config/agentsync/key.txt` on Unix, or remove `%APPDATA%/agentsync/key.txt` on Windows) if you really need a key wipe.
- Refuses to run in a non-TTY context without `--yes`, to protect against
  accidental destroys from piped scripts.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | Failure. Re-run only after addressing the printed cause. Some failures are not recoverable (a lost private key cannot be re-derived; a divergent vault must be reset or recloned). |

Every command prints a one-line summary on success and an actionable error on failure. If neither is printed, the command was killed externally — a Gatekeeper SIGKILL on the unsigned macOS release binary is the most common case. To avoid it, install via `bun install -g @chrisleekr/agentsync`, or verify the binary first with `gh attestation verify`. See [Operations → Verifying release binaries](operations.md#verifying-release-binaries).
