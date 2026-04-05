# Troubleshooting Guide

## Purpose

Use this guide when AgentSync setup or sync behavior fails and you need the next diagnostic step quickly, not a long theory dump.

## `init` failed or the vault did not push

Check:

- the remote URL is valid and reachable
- your Git transport is configured for that remote
- the vault directory is writable

Next step:

```bash
bun run src/cli.ts doctor
```

If the failure happened on the first remote pull, that can be normal for an empty remote.

## Push aborts because secrets were detected

Cause: AgentSync found literal tokens or credentials in content that would otherwise be encrypted and committed.

Next steps:

1. Remove the literal secret from the local config.
2. Replace it with the agent’s supported secret reference or login flow.
3. Run `push` again.

Do not bypass this by editing the vault manually.

## Private key missing or unreadable

Symptoms:

- `pull` fails to decrypt
- `doctor` reports a missing key

Next steps:

1. Check the expected key path in the runtime context.
2. Restore the backed-up private key file.
3. Ensure permissions are restrictive on Unix-like systems.

If the key is gone and not backed up, the vault cannot be recovered for that machine.

## Remote is unreachable

Symptoms:

- `push` or `pull` reports Git remote failure
- `doctor` warns that the remote cannot be reached

Next steps:

1. Verify network connectivity.
2. Verify Git credentials or SSH keys for the remote.
3. Confirm `remote.url` and `remote.branch` in `agentsync.toml`.

## A file is skipped during push

Likely cause: the source path matches a never-sync pattern such as credentials, sessions, or auth state.

Next step:

- Treat the skip as intentional unless the file is clearly safe and the policy should change in `src/core/sanitizer.ts`.

## `status` shows local-only or vault-only entries

- `local-only` means the machine has config that is not in the vault yet. Run `push` after reviewing the content.
- `vault-only` means the vault has artifacts this machine did not snapshot locally. Run `pull` if that content should exist here.

## Daemon is not running

Check:

- the service is installed for the current platform
- the daemon status command can reach the local IPC endpoint
- the platform-specific service file exists

Next steps:

```bash
bun run src/cli.ts daemon install
bun run src/cli.ts daemon status
```

If the service is installed but not healthy, inspect platform logs:

- macOS: LaunchAgent plist and user logs
- Linux: `systemctl --user status agentsync`
- Windows: Task Scheduler plus task history

## Platform-specific path confusion

Do not guess file paths. Use the values defined in `src/config/paths.ts` as the source of truth.

## Speckit workflow confusion

Use [speckit.md](speckit.md) when the problem is command order, artifact expectations, or which
workflow stage comes next.

Use [speckit-local-development.md](speckit-local-development.md) when the problem is active
feature detection, timestamp branch mapping, re-running a planning stage, or understanding why
the baseline workflow has no `.specify/extensions.yml`.

## Unsupported or future-facing expectations

If you expect a hosted admin surface, network API, or rich conflict-resolution UI, that is outside the current support surface. The supported model is the local CLI plus daemon workflow described in the command reference and architecture guide.

## Related docs

- [command-reference.md](command-reference.md)
- [development.md](development.md)
- [architecture.md](architecture.md)
