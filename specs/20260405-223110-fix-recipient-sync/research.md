# Research: Existing Vault Bootstrap Recovery

**Branch**: `20260405-223110-fix-recipient-sync` | **Date**: 2026-04-05

---

## Finding 1 — `init` currently creates local history before it knows whether the remote vault already exists

### Evidence

`src/commands/init.ts` writes `agentsync.toml` and `.gitignore`, initializes a local repository if needed, and then performs a best-effort `git.pull("origin", args.branch)` inside a broad `try/catch`. Any pull failure is treated as if the remote were a brand-new empty vault. The command then commits the local files and attempts `git.push --set-upstream`.

That sequence is safe only when the remote branch is truly empty. On a second laptop pointed at an already-populated remote vault, a pull failure can mean "existing remote history was not integrated," not "there is no remote history." The user-provided reproduction shows the resulting `push` fails with a non-fast-forward rejection.

### Decision

- **Chosen**: Make `init` remote-aware before it creates local history. The workflow should determine whether the remote branch already exists and, if it does, materialize or align to that history first, then apply the new machine's local configuration changes on top.
- **Rationale**: This removes the root cause instead of papering over the downstream `push` failure. The problem is not only the push rejection; it is the earlier incorrect assumption that any pull failure during bootstrap means "empty remote."
- **Alternatives considered**:
  - _Keep the current best-effort pull and improve the warning_: rejected because the user still lands in a broken local state.
  - _Force-push the local init commit_: rejected because it risks overwriting an existing encrypted vault.
  - _Auto-merge unrelated histories during bootstrap_: rejected because it creates a merge path from a locally invented history rather than joining the existing vault state cleanly.

---

## Finding 2 — Bare `git pull` makes behavior depend on user Git configuration and causes the divergent-branch prompt

### Evidence

`src/core/git.ts` exposes `GitClient.pull(remote, branch)` as a direct wrapper over `simple-git`'s `pull` with no reconciliation flags. That wrapper is used by `init`, `pull`, `push`, and both `key` subcommands.

The official Git documentation states that `git pull` first fetches and then integrates the remote branch, and that integration behavior depends on explicit flags such as `--ff-only`, `--rebase`, or `--no-rebase`, or on Git configuration such as `pull.rebase` and `pull.ff` when those flags are not provided. The same documentation also notes that `--ff-only` fails when local history has diverged rather than silently creating a merge or depending on user defaults. Source: https://git-scm.com/docs/git-pull

The user-provided reproduction shows exactly this ambiguity surfacing as `Error: Need to specify how to reconcile divergent branches.`

### Decision

- **Chosen**: Standardize AgentSync on an explicit fast-forward-only reconciliation rule for vault update paths, with user-facing recovery messaging when fast-forward is impossible.
- **Rationale**: The vault is an operational sync store, not a human-managed feature branch. Silent merges are undesirable, rebases are history-rewriting and harder to reason about, and relying on per-user Git config produces inconsistent behavior across machines. Fast-forward-only gives deterministic behavior and a safe failure mode.
- **Alternatives considered**:
  - _`--rebase`_: rejected because rebasing local vault commits rewrites history and increases recovery complexity.
  - _`--no-rebase` merge_: rejected because merge commits in the vault make machine bootstrap and automated sync harder to reason about.
  - _Keep the default and document required global Git config_: rejected because product behavior must not depend on user-specific Git settings.

---

## Finding 3 — Command result messaging currently allows false-success outcomes after reconciliation failure

### Evidence

`src/commands/pull.ts` catches all errors into `errors[]` and still returns `{ applied, errors }`. The CLI wrapper prints every error and then, when `dryRun` is false, always prints `Pull completed: ${result.applied} agent(s) synced.` even if `applied === 0` because Git failed before any agent apply work began.

The user-provided reproduction shows that exact outcome:

```text
Error: Need to specify how to reconcile divergent branches.
Pull completed: 0 agent(s) synced.
```

`push` and daemon paths have similar risk because they reuse the same Git helper and treat some pull failures as warnings.

### Decision

- **Chosen**: Treat Git reconciliation failures as hard command failures for sync operations unless the failure is a narrowly defined bootstrap-safe exception such as a genuinely absent remote ref during first-time initialization.
- **Rationale**: The product should fail closed. A sync command that could not reconcile repository state did not achieve its user-facing outcome and must not report success-style completion.
- **Alternatives considered**:
  - _Keep warning-style logging and success footer_: rejected because it misleads users into thinking the machine is healthy.
  - _Partially apply local agent state after Git failure_: rejected because local apply/push behavior must be based on a coherent vault state.

---

## Finding 4 — The fix must be centralized because the same reconciliation primitive is reused across multiple flows

### Evidence

The current `GitClient.pull` wrapper is called from:

- `src/commands/init.ts`
- `src/commands/pull.ts`
- `src/commands/push.ts`
- `src/commands/key.ts` (`add` and `rotate`)

The daemon reuses `performPull()` and `performPush()`, so any inconsistency in reconciliation behavior will surface in both CLI and background sync.

### Decision

- **Chosen**: Put the reconciliation policy in `src/core/git.ts` and expose helper methods or error categories that command-layer code can use consistently.
- **Rationale**: Centralizing Git policy prevents `init`, `pull`, `push`, `key`, and daemon flows from drifting into different interpretations of remote state.
- **Alternatives considered**:
  - _Patch each command independently_: rejected because the same bug class would recur as command behavior diverges.
