# Troubleshooting Guide

## Purpose

Use this guide when AgentSync setup or sync behavior fails and you need the next diagnostic step quickly, not a long theory dump.

This guide primarily assumes contributor-from-source execution from a local clone.
If you are using a published release, start in [../README.md](../README.md) and [command-reference.md](command-reference.md), then translate any `bun run src/cli.ts <command>` example here to `bunx --package @chrisleekr/agentsync agentsync <command>`.

## `init` failed or the vault did not push

Check:

- the remote URL is valid and reachable
- your Git transport is configured for that remote
- the vault directory is writable

Interpret the failure first:

- If the remote branch is empty, AgentSync should create the first vault commit locally and push it upstream.
- If the remote branch already exists, AgentSync should join that history before it writes this machine's config.
- If you see a fast-forward-only divergence error, the local vault already contains history that does not match the remote and must be recovered before `init` can finish.

Next step:

```bash
bun run src/cli.ts doctor
```

If the failure happened on the first remote pull, that can be normal for an empty remote.

## Local and remote vault history diverged

Symptoms:

- `pull`, `push`, `key add`, `key rotate`, or `init` reports that AgentSync only supports fast-forward sync
- the command tells you to reset or reclone the vault to `origin/<branch>` before retrying
- `pull` stops without printing `Pull completed: ...`

Next steps:

1. Back up any local-only vault changes you still need.
2. Inspect the local vault repo and confirm the configured remote branch is the intended source of truth.
3. Reset the local vault to the remote branch or remove the local vault directory and run `init` again against the same remote.
4. Re-run the original command only after the local vault matches the remote history.

Do not resolve this by relying on Git merge or rebase defaults. AgentSync intentionally fails closed here so every machine uses the same reconciliation model.

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

## My skill directory did not push

Likely causes, in order of frequency:

1. The directory is missing a `SKILL.md` sentinel file. AgentSync treats the presence of a real `SKILL.md` as the "this is a skill" marker — a directory without one is silently ignored (FR-002). Add the sentinel and re-run `push`.
2. The `SKILL.md` file is a symbolic link. The walker uses `lstat` so a symlinked sentinel fails the "is a real file" check and the skill is skipped (FR-016 sentinel rule). Replace the symlink with a real file or move the directory so the sentinel can be a real file.
3. The skill root itself is a symbolic link into a vendored pool. AgentSync refuses to follow the link because the outer tier of FR-016 forbids it. Make the skill root a real directory.
4. The directory name starts with a dot. Top-level `.something` entries under the skills root are skipped silently to protect vendor bundles like Codex's `.system/` directory (FR-017). Rename the directory so its name does not start with a dot.

## Push aborted because of a never-sync file inside a skill

Symptom:

```text
Push aborted: 1 security issue(s) detected.
[<agent>] never-sync inside skill: /Users/<you>/.<agent>/skills/<name>/auth.json
```

Cause: a file matching a never-sync pattern (e.g. `auth.json`, `credentials.json`, `.env*`) exists *inside* a skill directory. AgentSync escalates this to a fatal push abort rather than silently dropping the file, because the alternative would allow a crafted skill directory to smuggle credentials out of the never-sync safety net (FR-006).

Next steps:

1. Remove or rename the flagged file inside the skill directory.
2. Verify the directory no longer contains anything matched by `NEVER_SYNC_PATTERNS` in `src/core/sanitizer.ts`.
3. Re-run `push`.

Do not bypass this by editing the vault manually.

## I deleted a skill locally and it came back after pull

This is working as designed. AgentSync is **additive-by-default**: a local delete never removes the vault entry, and the next `pull` will happily restore the skill from the vault (FR-011).

If you want the skill gone for good on every machine, you must run the explicit removal verb:

```bash
bun run src/cli.ts skill remove <agent> <name>
```

That verb is the only operation that mutates the vault's skills namespace in the delete direction (FR-012).

## I removed a skill from the vault but it is still on my other laptop

Also working as designed. `skill remove` removes the vault artifact, but `pull` is extract-only and never deletes a local skill directory — even when the matching vault file is gone (FR-013). The safety reasoning is that a concurrent edit to the same skill on machine B should not silently vanish after machine A decides to remove it.

To finish removing the skill on the other laptop, delete the local skill directory manually on that machine:

```bash
rm -rf ~/.claude/skills/<name>   # or ~/.cursor/skills, ~/.codex/skills, ~/.copilot/skills
```

## A single file I deleted inside a skill reappears after pull on another machine

Symptom:

- On machine A you deleted `helper.md` from a skill (not the whole skill), re-ran `push`, and the updated vault tar no longer contains it.
- On machine B, after `pull`, `helper.md` is still present in the local skill directory.

Cause: this is symmetric to the section above and comes from the same FR-013 rule. `applyXxxSkill` extracts the vault tar *on top of* the existing local skill directory instead of replacing it. Files that are in the local directory but no longer in the tar survive the extract unchanged. AgentSync makes this trade deliberately — the alternative (replace the directory on every pull) would silently destroy any local edits or in-progress files a user happened to have inside the skill between pulls.

Next steps:

1. On the affected machine, `rm` the stale file(s) manually inside the skill directory.

   ```bash
   rm ~/.claude/skills/<name>/helper.md   # or the equivalent path on cursor/codex/copilot
   ```

2. Run `agentsync status` to confirm the skill now matches the vault for that machine.

Note: a future release may offer a `pull --replace-skills` flag for users who want vault-as-source-of-truth overwrite semantics, but the default will remain additive. Do not solve this by editing the vault directly or by running `git rm` inside the vault — both of those bypass the reconciliation logic.

## A vendored or symlinked skill did not sync

Cause: FR-016's outer tier refuses to walk a skill root that is itself a symbolic link. This prevents a vendored pool outside the skills directory from being silently tar'd into the encrypted vault through a follow-the-link archival.

Next steps:

- If the vendored content really belongs to you and should sync, copy the tree into the skills directory as a real directory instead of linking to it.
- If you do not want the vendored content in the vault, leave the symlink in place — it is already silently ignored.

## A helper file inside my skill is missing on the other machine after pull

Cause: the helper file was a symbolic link *inside* the skill directory. FR-016's inner tier filters symlink entries out of the tar archive at `archiveDirectory` time, so only the real files around the link are sent to the vault. This is intentional — symlinks inside a skill typically point at per-machine vendored state that must not leak across machines.

Next steps:

- If the helper file should sync, convert the symlink into a real file (`cp -L` is a convenient one-shot) and re-run `push`.
- If the helper file is machine-specific and should not sync, accept the omission and re-create the link manually on the other machine.

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
