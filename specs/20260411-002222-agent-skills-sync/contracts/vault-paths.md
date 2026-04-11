# Contract: Vault Skill Namespace Layout

**Feature**: 20260411-002222-agent-skills-sync
**Scope**: Defines the exact filesystem layout this feature writes to, reads from, and removes from inside the encrypted vault repository. Any code that touches skill artifacts MUST honor these paths exactly.

---

## Canonical vault path template

```text
<vaultDir>/<agent>/skills/<name>.tar.age
```

Where:

| Placeholder | Permitted values | Notes |
| ----------- | ---------------- | ----- |
| `<vaultDir>` | Absolute path returned by `resolveRuntimeContext()` | Cross-platform; the feature never hard-codes a vault location |
| `<agent>` | `claude` \| `cursor` \| `codex` \| `copilot` | Exactly these four. `vscode` is not in this set — adding a `vscode/skills/` directory is a contract violation |
| `<name>` | The basename of a real (non-symlink) directory under the agent's local skills root, containing a real (non-symlink) `SKILL.md` sentinel, whose name does not start with `.` | See the walker contract below for how this is computed |

The tarball-then-age chain is fixed: the `.tar.age` suffix is the on-disk encoding of "base64-encoded gzipped tar of the skill directory, then encrypted with the vault's age recipients". No alternative suffix (e.g. `.tgz.age`, `.tar.gz.age`) is produced or read by this feature.

---

## Writing to the vault

### What this feature writes

- `push` (via `performPush` in `src/commands/push.ts`) MAY write files at the canonical template above, one per real user-created skill per supported agent.
- `push` MUST NOT write any other file, directory, manifest, metadata blob, or tombstone under `<vaultDir>/<agent>/skills/`.
- The existing Copilot path at `<vaultDir>/copilot/skills/<name>.tar.age` is unchanged by this feature in shape; only the walker that produces those paths is retrofitted (per research R2/R4/R7).

### What this feature explicitly does not write

- No `<vaultDir>/<agent>/skills/manifest.*`
- No `<vaultDir>/<agent>/skills/index.json`
- No `<vaultDir>/<agent>/skills/<name>.tombstone`
- No `<vaultDir>/<agent>/skills/<name>/` (a directory at this path is a contract violation)
- No `<vaultDir>/vscode/skills/` (VS Code is not a skill-bearing agent)

---

## Reading from the vault

### On pull

`applyClaudeVault`, `applyCursorVault`, `applyCodexVault`, and `applyCopilotVault` each read files from `<vaultDir>/<agent>/skills/` using the existing `readAgeFiles` helper pattern (see `src/agents/copilot.ts:234-245` for the reference). They MUST:

- Iterate the `<vaultDir>/<agent>/skills/` directory if it exists; silently treat a missing directory as "no skills".
- Select files whose name matches `^[^/]+\.tar\.age$` (i.e., a `.tar.age` file directly in the directory, not nested).
- Ignore any file that does not match — do not warn, do not error. Forward compatibility: if a future feature adds a new shape under `<vaultDir>/<agent>/skills/` this feature's pull path must not crash on it.
- Decrypt each selected file, base64-decode the plaintext, and pass it to the agent's `applyXxxSkill(<name>, <base64Tar>)` helper, which extracts the tar into `<agentSkillsRoot>/<name>/`.

### On status

`statusCommand` in `src/commands/status.ts` (unchanged per research R9) recursively collects every `.age` file under `<vaultDir>/<agent>` via `collectAgeFiles`. Skill artifacts are therefore picked up automatically. Status MUST NOT special-case the `skills/` sub-directory.

---

## Removing from the vault

### On `skill remove <agent> <name>`

- The command MUST resolve the target as `<vaultDir>/<agent>/skills/<name>.tar.age` using exactly the canonical template above — no path aliasing, no symlink resolution on the vault side, no glob expansion.
- On file-not-found: exit with `process.exitCode = 1` and print the resolved path to help the user verify the agent/name spelling (see `contracts/skill-remove-cli.md`).
- On file-found: `unlink` the file, commit with message exactly `skill remove(<agent>): <name>`, push to the remote branch from `config.remote.branch`.
- The command MUST NOT delete any other file. Bulk removal is not in scope for this feature (FR-012).
- The command MUST NOT touch `<agentSkillsRoot>` on any machine, including the one running the command.

---

## Collision guarantees

- Two agents MAY each hold a skill named `my-skill`: `<vaultDir>/claude/skills/my-skill.tar.age` and `<vaultDir>/codex/skills/my-skill.tar.age` are distinct artifacts and do not interfere (FR-004).
- The existing `copilot/skills/` namespace is independent of the three new ones. Existing Copilot artifacts written before this feature's retrofit remain valid; the walker retrofit only changes which skills get archived on the next push, not the vault layout.
- A skill name MUST NOT contain path separators (`/` or `\`). The walker enforces this implicitly because it reads entries from `readdir` which returns basenames.

---

## Forbidden paths

No code in this feature may write, read, or delete at any of the following paths:

```text
<vaultDir>/vscode/skills/           # VS Code is not a skill-bearing agent
<vaultDir>/<agent>/skills/*.tgz     # Wrong suffix
<vaultDir>/<agent>/skills/*.age     # Wrong suffix — missing .tar
<vaultDir>/<agent>/skills/manifest* # No manifest file
<vaultDir>/<agent>/skills/*.json    # No metadata JSON
<vaultDir>/<agent>/skills/<name>/   # Directories under skills/ are forbidden
```

The reviewer's mental model: `<vaultDir>/<agent>/skills/` is a **flat directory of encrypted tarballs**, one per skill, nothing else. Any code or test that challenges that invariant should be questioned.
