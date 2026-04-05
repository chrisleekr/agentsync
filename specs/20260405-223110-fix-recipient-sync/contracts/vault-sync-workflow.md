# Contract: Vault Sync Workflow

**Branch**: `20260405-223110-fix-recipient-sync` | **Date**: 2026-04-05

This contract defines the observable behavior for AgentSync commands that interact with the
remote vault branch.

---

## Workflow: `init`

### Preconditions

| Input               | Requirement                           |
| ------------------- | ------------------------------------- |
| `--remote`          | Reachable Git remote URL              |
| `--branch`          | Target vault branch name              |
| Local runtime paths | Writable vault directory and key path |

### Existing-vault bootstrap contract

| Condition                            | Required behavior                                                           |
| ------------------------------------ | --------------------------------------------------------------------------- |
| Remote branch does not exist         | Create the first local commit and push it as the initial vault state        |
| Remote branch already exists         | Join the remote history before creating new local history                   |
| Remote state cannot be joined safely | Exit with an error outcome and do not claim the vault was fully initialized |

### User-visible outcome rules

- `init` may report success only if the machine ends with a usable local vault tied to the target remote branch.
- A non-fast-forward push after a local-only init commit is a contract violation.

---

## Workflow: `pull`

### Preconditions

| Input        | Requirement                           |
| ------------ | ------------------------------------- |
| Local config | Parseable `agentsync.toml`            |
| Private key  | Readable local private key            |
| Git state    | Local repository already bootstrapped |

### Reconciliation contract

| Condition                                    | Required behavior                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Remote branch is ahead and local is ancestor | Fast-forward local state and continue applying artifacts                                   |
| Local and remote histories diverge           | Stop with a controlled error and recovery instruction                                      |
| Remote branch missing unexpectedly           | Stop with a controlled error unless the caller is on an explicit first-time bootstrap path |

### User-visible outcome rules

- `pull` must not print a success completion footer when reconciliation failed before any apply work.
- Raw Git ambiguity such as "Need to specify how to reconcile divergent branches" should not be the product's final user-facing explanation.

---

## Workflow: `push`, `key add`, `key rotate`, daemon sync

### Shared reconciliation contract

| Workflow             | Required behavior before mutating vault content                           |
| -------------------- | ------------------------------------------------------------------------- |
| `push`               | Reconcile to latest remote state using the shared fast-forward-only rule  |
| `key add`            | Reconcile to latest remote state before re-encrypting vault files         |
| `key rotate`         | Reconcile to latest remote state before re-encrypting vault files         |
| Daemon pull and push | Reuse the same command-layer reconciliation behavior and error categories |

### Safety rules

- No workflow may implicitly merge or rebase the vault branch.
- No workflow may continue to encrypt, apply, or re-encrypt vault content after a reconciliation failure.
- Divergence handling must be consistent across CLI and daemon surfaces.
