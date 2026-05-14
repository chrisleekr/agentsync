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

## Command index

| Command | Purpose |
|---|---|
| [`init`](#init) | Bootstrap the vault, machine key, and config. |
| [`push`](#push) | Snapshot, sanitise, encrypt, and fast-forward to the vault. |
| [`pull`](#pull) | Fetch the vault, decrypt, and apply locally. |
| [`status`](#status) | Compare local snapshot to decrypted vault state. |
| [`doctor`](#doctor) | Check the local environment before blaming sync logic. |
| [`daemon`](#daemon) | Install, start, stop, and inspect the background daemon. |
| [`key`](#key) | Add a recipient or rotate the current machine key. |
| [`skill`](#skill) | Remove a skill from the vault. |
| [`migrate`](#migrate) | Translate configuration between agent formats. |

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

- Push is **additive by default**: deleting a skill locally does not remove it from the vault. Use [`skill remove`](#skill) for explicit removal.
- The sanitiser is a hard gate. Literal secrets or never-sync paths abort the entire push before bytes leave the machine. See [Push aborts because secrets were detected](operations.md#push-aborts-because-secrets-were-detected).
- Reconciliation is fast-forward only. Divergence aborts the push with recovery guidance.
- `--dry-run` exercises the snapshot, sanitiser, and encryption pipeline so previews reflect what would actually be written.

## pull

**Why**: Fetch the latest vault state, decrypt for the local recipient, and apply to local agent paths.

**Usage**:

```bash
agentsync pull
agentsync pull --agent cursor
agentsync pull --dry-run
```

**Flags**:

| Flag | Default | Description |
|---|---|---|
| `--agent` | all enabled | Restrict to one agent. |
| `--dry-run` | `false` | Show what would be applied without writing locally. |
| `--force` | `false` | Skip interactive conflict prompts. |

**Outcome**: supported local agent files are updated from the vault, including per-agent skills under `claude/skills/`, `codex/skills/`, `cursor/skills/`, and `copilot/skills/`. Claude Code plugins under `claude/plugins/<name>/` round-trip back to `~/.claude/plugins/<name>/`. `marketplace.json` is only applied when `claudePlugins.syncMarketplace = true` is set locally.

**Caveats**:

- Pull is **extract-only**: it never removes a local file the vault does not contain. This is intentional so an in-progress local edit cannot be wiped by a remote that omits the file. See [I removed a skill from the vault but it is still on my other laptop](operations.md#a-skill-i-deleted-reappears-after-pull-on-another-machine).
- Pull applies only enabled or explicitly requested agents.
- Reconciliation is fast-forward only.

## status

**Why**: Compare the local snapshot to the decrypted vault state for the enabled agents.

**Usage**:

```bash
agentsync status
agentsync status --verbose
```

**Flags**:

| Flag | Default | Description |
|---|---|---|
| `--verbose` | `false` | Show per-file hashes alongside each row. |

**Outcome**: a per-agent report covering every enabled agent. Each row carries one of the following status strings, printed verbatim:

- `synced` — local content matches the vault.
- `local-changed` — both sides have the file but the content differs. Run `push` to publish the local copy, or `pull` after backing up the local copy.
- `local-only` — the machine has content the vault does not. Run `push`.
- `vault-only` — the vault has content this machine does not. Run `pull`.
- `error` — snapshot or decryption failed for that row. The error detail is printed in the same row; address it before trusting the rest of the report.

**Caveats**:

- `status` is read-only. It never mutates the vault or local files.
- Vault-only entries marked "not on this machine" are normal when another machine snapshots an agent this machine does not enable.

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

## daemon

**Why**: Run AgentSync as a background process that watches your agent paths, debounces pushes, and runs periodic pulls.

**Usage**:

```bash
agentsync daemon install     # write the OS service descriptor
agentsync daemon start       # idempotent
agentsync daemon status      # IPC ping
agentsync daemon stop
agentsync daemon uninstall
```

**Outcome**: a long-running process supervised by launchd (macOS), systemd-user (Linux), or Task Scheduler (Windows). The daemon serialises sync operations through an internal queue so no two operations race.

**Caveats**:

- Only one daemon runs per user. A second-instance check exits cleanly if a daemon is already up.
- A transient sync failure triggers one automatic retry. If the retry also fails, the error is recorded but the daemon stays alive so the next change can trigger a fresh push.
- See [Daemon](operations.md#daemon) for install paths per OS, lifecycle, and log locations.

## key

**Why**: Add a new recipient or rotate the current machine's keypair without changing vault semantics.

**Usage**:

```bash
agentsync key add <name> <age-public-key>
agentsync key rotate
```

**Outcome**: every existing vault artefact is decrypted under the current key and re-encrypted under the updated recipient set, then the change is committed and pushed.

**Caveats**:

- `key add` and `key rotate` reconcile against the latest remote state before they rewrite encrypted vault content.
- If the vault history has diverged, key-management commands stop until the vault is reset or recloned. See [Recover from divergence](operations.md#recover-from-divergence).
- Rotation depends on the **old** private key still being available so existing vault files can be decrypted. Back up the old key before rotation if you intend to retire that identity entirely.
- Recipient names are stable config keys and are visible in the vault repository. Use names that describe the machine clearly without leaking sensitive context.

## skill

**Why**: Remove a skill from the vault without affecting the rest of the snapshot. This is AgentSync's only explicit, non-additive operation.

**Usage**:

```bash
agentsync skill remove <agent> <name>
```

**Outcome**: the vault artefact for that skill is deleted, the change is committed and pushed under the fast-forward reconciliation rule. The local skill directory on the current machine is left untouched.

**Caveats**:

- `skill remove` is the **only** non-additive operation in AgentSync. It deletes the vault artefact but does not remove the local skill directory on the current or other machines.
- After `skill remove`, every machine that pulled the skill previously still has the local directory until you delete it manually there. See [A skill I deleted reappears after pull on another machine](operations.md#a-skill-i-deleted-reappears-after-pull-on-another-machine).
- To snapshot or apply a single skill, use the bulk `push` and `pull` commands with `--agent`. There is no targeted `skill push` or `skill pull`; the snapshot for an agent always includes every skill that survives the walker contract.

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

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | Failure. Re-run only after addressing the printed cause. Some failures are not recoverable (a lost private key cannot be re-derived; a divergent vault must be reset or recloned). |

Every command prints a one-line summary on success and an actionable error on failure. If neither is printed, the command was killed externally (a SIGKILL on an unsigned macOS binary is the most common case; see the GitHub Releases for the signed binary).
