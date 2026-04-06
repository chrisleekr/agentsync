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

**Outcome**: encrypted `.age` or `.tar.age` artifacts are committed and pushed to the configured branch.

**Caveats**:

- AgentSync reconciles against the remote with a fast-forward-only rule before it writes encrypted artifacts.
- If the local vault and remote vault have diverged, `push` stops before writing or encrypting new artifact content.
- Push aborts when literal secrets are detected in supported config content.
- Files matching never-sync patterns are skipped even if an agent adapter sees them.

## pull

**Why**: Pull the latest vault state and apply decrypted artifacts onto the local machine.

**Typical usage**:

```bash
bunx --package @chrisleekr/agentsync agentsync pull
bunx --package @chrisleekr/agentsync agentsync pull --agent cursor
```

**Needs**: initialized vault, readable private key, reachable Git remote.

**Outcome**: supported local agent files are updated from the vault.

**Caveats**:

- Pull applies only enabled or explicitly requested agents.
- Pull uses the same fast-forward-only reconciliation rule as `push`, `key`, and daemon sync.
- If local and remote vault history diverged, `pull` exits with a recovery message and no success footer.
- If the private key is missing, the command cannot decrypt anything.

## status

**Why**: Compare local snapshot content with the decrypted vault to find drift.

**Typical usage**:

```bash
bunx --package @chrisleekr/agentsync agentsync status
bunx --package @chrisleekr/agentsync agentsync status --verbose
```

**Outcome**: table of synced, local-only, vault-only, changed, or error states.

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
- daemon service installation state

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
