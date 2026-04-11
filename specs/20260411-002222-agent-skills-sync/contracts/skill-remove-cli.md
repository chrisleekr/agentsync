# Contract: `agentsync skill remove` CLI

**Feature**: 20260411-002222-agent-skills-sync
**Scope**: The user-facing signature, exit codes, and output format of the new `skill remove` CLI verb introduced by FR-012. Tests at `src/commands/__tests__/skill.test.ts` assert every row in this contract.

---

## Signature

```text
agentsync skill remove <agent> <name>
```

- `<agent>` — positional, required. One of: `claude`, `cursor`, `codex`, `copilot`. Any other string is a usage error (see exit codes).
- `<name>` — positional, required. The basename of the skill in the vault. No path separators, no glob metacharacters. Exactly matches the `<name>` that would appear in `<vaultDir>/<agent>/skills/<name>.tar.age`.

The command is registered under a citty command group called `skill`, so `agentsync skill --help` lists it (and leaves room for future `list` / `info` verbs without renaming anything).

### Reserved for future use, not in scope

- `agentsync skill list [<agent>]`
- `agentsync skill info <agent> <name>`
- `agentsync skill remove --all <agent>` or glob patterns — explicitly out of scope per FR-012's one-at-a-time rule.
- `--dry-run` on `skill remove` — not in scope for v1. If added later, it MUST NOT touch the vault file and MUST NOT commit or push.

---

## Exit codes

| Code | Scenario | Output behavior |
| ---- | -------- | --------------- |
| `0` | Removal succeeded (file deleted, commit landed, push succeeded) | `log.success("Removed <agent>/<name> from vault (commit <sha7>)")` |
| `1` | Skill not found in vault for the given agent | `log.error("Skill not found: <agent>/<name>")` followed by `log.info("Looked for: <resolved vault path>")`. **No** Git operation, **no** file write |
| `1` | Unknown agent name | `log.error("Unknown agent: <provided>. Supported: claude, cursor, codex, copilot")` |
| `1` | `reconcileWithRemote` failed before deletion | Same error surface as `push` — forward the upstream guidance. **No** file write, **no** commit |
| `1` | Git commit or push failed **after** the file was `unlink`ed locally | `log.error("Removal staged but not pushed: <git error>")`. The vault working tree has a staged deletion; running `skill remove` or `push` again will resolve it |

Exit code `1` is reused for every error case to keep the surface narrow. Machine-readable output (JSON) is not in scope for v1.

### What exit code `0` guarantees

- The target `.age` file is absent from the remote branch named in `config.remote.branch`.
- The local vault working tree is clean with respect to that file.
- **Zero** local skill directories on the invoking machine were touched (FR-012).
- **Zero** local skill directories on any other machine are affected until that machine pulls; even then, FR-013 guarantees the pull does not delete any local skill (see contracts/walker-interface.md for the pull-side no-op rule).

---

## Output format

All output goes through `@clack/prompts`' `log` facility, matching every other command in this CLI. No raw `console.log` calls are permitted (Principle IV's `noConsole: error` rule).

### Success output

```text
◇  Removed claude/my-skill from vault (commit a1b2c3d)
```

### Not-found output

```text
■  Skill not found: claude/my-skill
◆  Looked for: /Users/<user>/.config/agentsync/vault/claude/skills/my-skill.tar.age
```

The resolved path is printed so the user can verify the agent and name spelling, especially in scripts where a typo is the most likely cause.

### Git-error output

```text
■  Removal staged but not pushed: <git error as returned by simple-git>
◆  Hint: run `agentsync push` or re-run `agentsync skill remove claude my-skill` to retry.
```

---

## Inputs the command does NOT accept

- `--force` — skill removal is already a deliberate single-target action; forcing adds nothing.
- `--local` — removal is vault-only by construction (FR-012); there is nothing to make local.
- `--all` — one skill at a time (FR-012).
- `--agent` as a flag — the positional `<agent>` argument is the canonical form; flag form would create two ways to say the same thing.

---

## Preconditions the command MUST check before touching the vault

1. `resolveRuntimeContext()` returns a valid vault dir.
2. `loadConfig(resolveConfigPath(runtime.vaultDir))` parses cleanly.
3. `<agent>` is a recognised agent name.
4. The resolved `<vaultDir>/<agent>/skills/<name>.tar.age` path exists on disk.

Failing (1) or (2) yields the same error surface as `push` failing on those preconditions — existing helpers are reused verbatim.

Failing (3) or (4) yields exit code 1 with the messages defined above. The vault working tree is not mutated in either case.

---

## Pull-side guarantees (per FR-013)

These are properties of the broader system that `skill remove` relies on — they are implemented in the existing `applyXxxVault` functions and not by `skill remove` itself. They are listed here so the contract is complete:

- A subsequent `pull` on any machine MUST NOT delete the local skill directory for the removed `(agent, name)` pair.
- A subsequent `pull` on a machine that did not have the skill locally MUST NOT restore it.
- A subsequent `push` from any machine that also does not have the skill locally MUST NOT re-introduce it to the vault.

These three properties together are what make `skill remove` safe to run without announcing to the team — no other machine's local files are affected.
