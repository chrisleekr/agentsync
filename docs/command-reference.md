# Command Reference

## Purpose

This guide is the concise lookup surface for supported AgentSync commands. Use it when you already know the problem you are solving and need the right command, inputs, and caveats quickly.

## Released CLI install path

Use the published CLI path only after the version you want appears in both the npm package registry and the GitHub Releases list.

Use this guide when you are running a published release through `bunx`.
If you are working from a local clone or testing unreleased changes, use the source-based commands in [development.md](development.md) instead.

Released CLI verification command:

```bash
bunx --package @chrisleekr/agentsync agentsync --version
```

Published command pattern:

```bash
bunx --package @chrisleekr/agentsync agentsync <command> [options]
```

Use the GitHub Release record as the canonical source for:

- the published version you are installing
- what changed in that release

Start here:

- [Latest release](https://github.com/chrisleekr/agentsync/releases/latest)
- [All releases](https://github.com/chrisleekr/agentsync/releases)

## Support-state rule

Everything in this guide describes the released CLI path once a version has been published. If a behavior is not listed here, treat it as unsupported or future-facing.

If you are running from a local clone instead of the published package, use the source-based commands in [development.md](development.md).

## init

**Why**: Create the local vault workspace, local key file, `agentsync.toml`, and initial Git remote wiring.

**Typical usage**:

```bash
bunx --package @chrisleekr/agentsync agentsync init --remote <git-url> --branch main
```

**Needs**: remote URL, optional branch, writable local runtime directory.

**Outcome**: local vault directory exists, machine recipient is registered in config, and AgentSync either creates the first remote commit or joins the existing remote history before writing machine-specific changes.

**Caveats**:

- An empty remote branch is treated as first-machine bootstrap; an existing remote branch is joined before AgentSync writes local history.
- If the local vault already diverged from the configured remote branch, `init` stops with a recovery error instead of pushing a local-first history.
- The generated private key must be backed up outside the vault.

## push

**Why**: Snapshot local agent configuration, redact secrets, encrypt artifacts, and push them to the vault.

**Typical usage**:

```bash
bunx --package @chrisleekr/agentsync agentsync push
bunx --package @chrisleekr/agentsync agentsync push --agent claude
```

**Needs**: initialized vault, configured recipients, readable local agent config.

**Outcome**: encrypted `.age` or `.tar.age` artifacts are committed and pushed to the configured branch. Per-user *skills* under `~/.claude/skills/`, `~/.codex/skills/`, `~/.cursor/skills/`, and `~/.copilot/skills/` are packaged through the shared skills walker and land in the matching vault namespace (`claude/skills/<name>.tar.age`, `codex/skills/<name>.tar.age`, `cursor/skills/<name>.tar.age`, `copilot/skills/<name>.tar.age`).

**Caveats**:

- AgentSync reconciles against the remote with a fast-forward-only rule before it writes encrypted artifacts.
- If the local vault and remote vault have diverged, `push` stops before writing or encrypting new artifact content.
- Push aborts when literal secrets are detected in supported config content.
- Files matching never-sync patterns are skipped even if an agent adapter sees them.
- Push aborts fatally when a never-sync file is discovered *inside* a skill directory (FR-006). Remove the file and re-run before retrying.
- A top-level symlinked skill root or a symlinked `SKILL.md` sentinel is skipped silently, and symlinked helper files *inside* a skill are filtered out of the archive (FR-016).
- Push is additive-by-default: deleting a skill locally does NOT remove it from the vault on any machine. Use `skill remove` for explicit removal (FR-011 / FR-012).

## pull

**Why**: Pull the latest vault state and apply decrypted artifacts onto the local machine.

**Typical usage**:

```bash
bunx --package @chrisleekr/agentsync agentsync pull
bunx --package @chrisleekr/agentsync agentsync pull --agent cursor
```

**Needs**: initialized vault, readable private key, reachable Git remote.

**Outcome**: supported local agent files are updated from the vault, including any per-agent skills stored under `claude/skills/`, `codex/skills/`, `cursor/skills/`, and `copilot/skills/`.

**Caveats**:

- Pull applies only enabled or explicitly requested agents.
- Pull uses the same fast-forward-only reconciliation rule as `push`, `key`, and daemon sync.
- If local and remote vault history diverged, `pull` exits with a recovery message and no success footer.
- If the private key is missing, the command cannot decrypt anything.
- Pull is extract-only and never deletes an existing local skill directory, even when the matching vault artifact is gone (FR-013). `skill remove` only removes the vault artifact; to complete the removal on this machine or any other machine, delete the local skill directory by hand (`rm -rf ~/.<agent>/skills/<name>`).

## status

**Why**: Compare local snapshot content with the decrypted vault to find drift.

**Typical usage**:

```bash
bunx --package @chrisleekr/agentsync agentsync status
bunx --package @chrisleekr/agentsync agentsync status --verbose
```

**Outcome**: table of synced, local-only, vault-only, changed, or error states. Skill artifacts (`<agent>/skills/<name>.tar.age`) appear alongside other vault entries and report drift exactly the same way any other artifact does.

## doctor

**Why**: Check the local environment before blaming sync logic.

**Typical usage**:

```bash
bunx --package @chrisleekr/agentsync agentsync doctor
```

**Checks include**:

- private key presence and permissions
- config parseability
- age-encryption module availability
- remote reachability
- obvious unencrypted sensitive files in the vault
- readability of the per-agent skills directories under `~/.claude/skills/`, `~/.codex/skills/`, and `~/.cursor/skills/` (warns if a directory is missing or unreadable)
- daemon service installation state

## skill remove

**Why**: Remove one skill from the vault explicitly. This is the **only** operation that takes a skill out of the vault — every other AgentSync command is additive-by-default (FR-011 / FR-012).

**Typical usage**:

```bash
bunx --package @chrisleekr/agentsync agentsync skill remove claude my-skill
bunx --package @chrisleekr/agentsync agentsync skill remove codex review-helper
bunx --package @chrisleekr/agentsync agentsync skill remove cursor polish-prompt
bunx --package @chrisleekr/agentsync agentsync skill remove copilot debug-flow
```

**Signature**: `skill remove <agent> <name>` — both positional arguments are required. `<agent>` must be one of `claude`, `cursor`, `codex`, or `copilot`; `vscode` and any other value are rejected. `<name>` is the basename of the skill (no extension, no path separators).

**Outcome on success**: the file `<vaultDir>/<agent>/skills/<name>.tar.age` is removed, a `skill remove(<agent>): <name>` commit is created, and the commit is pushed to the configured remote branch. The success log line includes the 7-character short SHA.

**Exit codes**:

| Code | Scenario | Output |
| ---- | -------- | ------ |
| `0` | File removed, commit landed, push succeeded | `Removed <agent>/<name> from vault (commit <sha7>)` |
| `1` | Skill not found in vault | `Skill not found: <agent>/<name>` + `Looked for: <resolved path>` |
| `1` | Unknown agent name | `Unknown agent: <provided>. Supported: claude, cursor, codex, copilot` |
| `1` | Reconcile with remote failed **before** the vault file was touched | `<upstream reconcile error>` — the vault working tree is unchanged; resolve the remote divergence and retry |
| `1` | Git commit or push failed **after** the vault file was unlinked locally | `Removal staged but not pushed: <git error>` + hint to re-run `agentsync push` or `agentsync skill remove <agent> <name>` to finish the removal |

See `specs/20260411-002222-agent-skills-sync/contracts/skill-remove-cli.md` for the authoritative row-by-row mapping; the table above mirrors that contract.

**Safety guarantees (critical)**:

- The command **never** touches any local skill directory on any machine, including the machine running the command (FR-012).
- A subsequent `pull` on another machine leaves that machine's local skill directory **untouched** because `applyXxxVault` is extract-only (FR-013).
- The command removes one skill at a time. `--all`, `--force`, and glob patterns are intentionally not supported.

## daemon

**Why**: Install, start, stop, query, or remove the background auto-sync service.

**Typical usage**:

```bash
bunx --package @chrisleekr/agentsync agentsync daemon install
bunx --package @chrisleekr/agentsync agentsync daemon status
```

**Outcome**: manages the OS-specific wrapper around `daemon _run`.

**Caveats**:

- Installation paths differ by OS.
- The daemon communicates over a local socket or named pipe, not over a network API.

## key

**Why**: Add a new recipient or rotate the current machine key without changing vault semantics.

**Typical usage**:

```bash
bunx --package @chrisleekr/agentsync agentsync key add <name> <age-public-key>
bunx --package @chrisleekr/agentsync agentsync key rotate
```

**Outcome**: the vault is re-encrypted for the updated recipient set.

**Caveats**:

- `key add` and `key rotate` reconcile against the latest remote state before they rewrite encrypted vault content.
- If the vault history diverged, key-management commands stop until the vault is reset or recloned onto the current remote branch.
- Rotation depends on the old private key still being available so existing vault files can be decrypted.
- Recipient names should describe machines clearly because they become the stable config key.

## migrate

**Why**: Translate configuration from one agent's format to another — global rules, MCP servers, or commands.

**Typical usage**:

```bash
bunx --package @chrisleekr/agentsync agentsync migrate --from claude --to cursor
bunx --package @chrisleekr/agentsync agentsync migrate --from claude --to all --type mcp
bunx --package @chrisleekr/agentsync agentsync migrate --from claude --to cursor --type commands --name review.md
bunx --package @chrisleekr/agentsync agentsync migrate --from claude --to cursor --dry-run
```

**Needs**: source agent config files present on disk. No vault initialisation required.

**Outcome**: target agent config files are created or updated with translated content from the source agent.

**Config types**: `global-rules`, `mcp`, `commands`. Omit `--type` to migrate all.

**Caveats**:

- Migration is a one-shot local operation — it does not push or pull from the vault.
- Colliding entries are overwritten. For MCP servers, per-server merge preserves target-only servers.
- Migration aborts if literal secrets (API keys, tokens) are detected in MCP content.
- Skills migration is not supported — deferred to a follow-up issue.
- Use `--dry-run` to preview changes before writing.

## Source-based execution

If you are working from a clone before a package is published, use the contributor workflow from [development.md](development.md) and run commands through `bun run src/cli.ts ...`.

## Related docs

- [development.md](development.md)
- [architecture.md](architecture.md)
- [troubleshooting.md](troubleshooting.md)
