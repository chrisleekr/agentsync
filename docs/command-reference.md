# Command Reference

## Purpose

This guide is the concise lookup surface for supported AgentSync commands. Use it when you already know the problem you are solving and need the right command, inputs, and caveats quickly.

## Support-state rule

Everything in this guide describes the current local CLI and daemon workflow. If a behavior is not listed here, treat it as unsupported or future-facing until the implementation lands.

## init

**Why**: Create the local vault workspace, local key file, `agentsync.toml`, and initial Git remote wiring.

**Typical usage**:

```bash
bun run src/cli.ts init --remote <git-url> --branch main
```

**Needs**: remote URL, optional branch, writable local runtime directory.

**Outcome**: local vault directory exists, machine recipient is registered in config, and the initial commit is pushed when the remote is reachable.

**Caveats**:

- First-time pull may fail harmlessly if the remote has no history yet.
- The generated private key must be backed up outside the vault.

## push

**Why**: Snapshot local agent configuration, redact secrets, encrypt artifacts, and push them to the vault.

**Typical usage**:

```bash
bun run src/cli.ts push
bun run src/cli.ts push --agent claude
```

**Needs**: initialized vault, configured recipients, readable local agent config.

**Outcome**: encrypted `.age` or `.tar.age` artifacts are committed and pushed to the configured branch.

**Caveats**:

- AgentSync pulls before push to reduce conflicts.
- Push aborts when literal secrets are detected in supported config content.
- Files matching never-sync patterns are skipped even if an agent adapter sees them.

## pull

**Why**: Pull the latest vault state and apply decrypted artifacts onto the local machine.

**Typical usage**:

```bash
bun run src/cli.ts pull
bun run src/cli.ts pull --agent cursor
```

**Needs**: initialized vault, readable private key, reachable Git remote.

**Outcome**: supported local agent files are updated from the vault.

**Caveats**:

- Pull applies only enabled or explicitly requested agents.
- If the private key is missing, the command cannot decrypt anything.

## status

**Why**: Compare local snapshot content with the decrypted vault to find drift.

**Typical usage**:

```bash
bun run src/cli.ts status
bun run src/cli.ts status --verbose
```

**Outcome**: table of synced, local-only, vault-only, changed, or error states.

## doctor

**Why**: Check the local environment before blaming sync logic.

**Typical usage**:

```bash
bun run src/cli.ts doctor
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
bun run src/cli.ts daemon install
bun run src/cli.ts daemon status
```

**Outcome**: manages the OS-specific wrapper around `daemon _run`.

**Caveats**:

- Installation paths differ by OS.
- The daemon communicates over a local socket or named pipe, not over a network API.

## key

**Why**: Add a new recipient or rotate the current machine key without changing vault semantics.

**Typical usage**:

```bash
bun run src/cli.ts key add <name> <age-public-key>
bun run src/cli.ts key rotate
```

**Outcome**: the vault is re-encrypted for the updated recipient set.

**Caveats**:

- Rotation depends on the old private key still being available so existing vault files can be decrypted.
- Recipient names should describe machines clearly because they become the stable config key.

## Related docs

- [development.md](development.md)
- [architecture.md](architecture.md)
- [troubleshooting.md](troubleshooting.md)
