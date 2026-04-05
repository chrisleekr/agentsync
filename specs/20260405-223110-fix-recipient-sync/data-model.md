# Data Model: Existing Vault Bootstrap Recovery

**Branch**: `20260405-223110-fix-recipient-sync` | **Date**: 2026-04-05

This feature does not add a new persisted application schema. The design model is the vault
repository state machine that governs how AgentSync bootstraps a machine and how it decides
whether remote state can be integrated safely.

---

## Entity: Remote Vault State

| Field          | Type           | Description                                  |
| -------------- | -------------- | -------------------------------------------- |
| `remoteName`   | string         | Git remote alias, currently `origin`         |
| `branch`       | string         | Configured vault branch, typically `main`    |
| `branchExists` | boolean        | Whether the target remote branch exists      |
| `headCommit`   | string or null | Remote head SHA when the branch exists       |
| `isEmpty`      | boolean        | Whether the target branch has no commits yet |

### State meanings

- `isEmpty = true`: first-machine bootstrap path is allowed
- `branchExists = true` and `headCommit != null`: existing-vault join or update path is required

---

## Entity: Local Vault State

| Field                   | Type           | Description                                              |
| ----------------------- | -------------- | -------------------------------------------------------- |
| `repoInitialized`       | boolean        | Whether `runtime.vaultDir` already contains `.git`       |
| `currentBranch`         | string or null | Checked-out local branch                                 |
| `upstreamConfigured`    | boolean        | Whether local branch tracks the configured remote branch |
| `headCommit`            | string or null | Local head SHA when commits exist                        |
| `hasUncommittedChanges` | boolean        | Whether working tree or index contains changes           |

### State meanings

- Fresh bootstrap: `repoInitialized = false` or no local commits yet
- Existing machine update: initialized repo plus tracked branch
- Broken bootstrap: initialized repo plus local-only commit that is not ancestor of remote

---

## Entity: Reconciliation Policy

| Field                  | Type    | Description                                                                           |
| ---------------------- | ------- | ------------------------------------------------------------------------------------- |
| `mode`                 | enum    | `bootstrap-empty`, `bootstrap-existing`, `update-ff-only`, `manual-recovery-required` |
| `allowFastForwardOnly` | boolean | Whether only descendant updates are accepted                                          |
| `allowImplicitMerge`   | boolean | Must remain `false` for this feature                                                  |
| `allowImplicitRebase`  | boolean | Must remain `false` for this feature                                                  |

### Business rules

- Existing remote history must never be overwritten by a local init commit.
- Update flows must not depend on user-level `pull.rebase` or related Git configuration.
- Divergence results in a controlled failure, not an automatic merge or rebase.

---

## Entity: Reconciliation Result

| Field            | Type    | Description                                                                                                     |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `status`         | enum    | `noop`, `fast-forwarded`, `bootstrapped-existing`, `bootstrapped-empty`, `diverged`, `remote-missing`, `failed` |
| `messageKey`     | string  | Stable category for command-layer messaging                                                                     |
| `safeToContinue` | boolean | Whether the caller may proceed with commit, apply, or re-encryption                                             |

### Allowed transitions

```text
unknown
  -> remote-missing
  -> bootstrapped-empty
  -> bootstrapped-existing
  -> fast-forwarded
  -> diverged
  -> failed
```

Only `bootstrapped-empty`, `bootstrapped-existing`, `fast-forwarded`, and `noop` permit later sync work.

---

## Entity: Command Outcome

| Field                  | Type                  | Description                                                                   |
| ---------------------- | --------------------- | ----------------------------------------------------------------------------- |
| `command`              | enum                  | `init`, `pull`, `push`, `key-add`, `key-rotate`, `daemon-pull`, `daemon-push` |
| `reconciliationResult` | Reconciliation Result | Repository-state outcome for this run                                         |
| `workPerformed`        | boolean               | Whether the command actually applied, encrypted, or pushed vault data         |
| `userVisibleStatus`    | enum                  | `success`, `warning`, `error`                                                 |

### Output rules

- `userVisibleStatus = success` only when `safeToContinue = true` and the command reached its intended outcome.
- `diverged` and `failed` must map to `error`, not `success`.
