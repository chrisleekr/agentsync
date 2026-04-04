# Contract: Workflow Interface

**Branch**: `20260404-231650-fix-ci-pipeline` | **Date**: 2026-04-04

This document defines the observable interface contracts for the two GitHub Actions workflows
modified by this feature — what events trigger them, what the job dependency chain is, what
the expected outputs and exit conditions are, and what external state they read or mutate.

---

## Workflow: `ci.yml` (CI)

### Trigger Events

| Event                | Condition                          | Behaviour                                     |
| -------------------- | ---------------------------------- | --------------------------------------------- |
| `push`               | target branch is `main`            | Full pipeline runs: lint → test → build       |
| `pull_request`       | target branch is `main`            | Full pipeline runs: lint → test → build       |
| `push` (concurrency) | Same branch, older run in-progress | Older run cancelled; only latest run executes |

### Job Dependency Contract (Target State)

```
lint
 └─ test   (needs: lint)
     └─ build  (needs: test)
```

- If `lint` **fails**: `test` and `build` are **skipped** (not queued). No wasted compute.
- If `test` **fails**: `build` is **skipped**.
- If `lint` **passes** and `test` **passes**: `build` runs.

### Inputs (Read from Repository)

| Input                | Source                                       | Used by  |
| -------------------- | -------------------------------------------- | -------- |
| Source code          | `actions/checkout@v4`                        | all jobs |
| Bun version          | `bun-version: "1.3.9"` (hardcoded)           | all jobs |
| Bun dependency cache | `~/.bun/install/cache` (restored from cache) | all jobs |
| Lockfile hash        | `bun.lock` (for cache key)                   | all jobs |

### Outputs (Written / Mutated)

| Output                           | Written by         | Consumed by                    |
| -------------------------------- | ------------------ | ------------------------------ |
| Cache entry                      | `actions/cache@v4` | future CI runs                 |
| Job status (pass/fail)           | GitHub Actions     | PR merge gate                  |
| Binary artifact `dist/agentsync` | `build` job        | discarded (not uploaded in CI) |

### Permissions

| Permission | Level  | Reason        |
| ---------- | ------ | ------------- |
| `contents` | `read` | checkout only |

---

## Workflow: `release-please.yml` (Release)

### Trigger Events

| Event  | Condition               | Behaviour                                                                        |
| ------ | ----------------------- | -------------------------------------------------------------------------------- |
| `push` | target branch is `main` | `release-please` job runs; `build-and-upload` runs only if a release was created |

### Job Dependency Contract

```
release-please
 └─ build-and-upload  (needs: release-please, if: release_created == true)
```

The `build-and-upload` job uses a matrix strategy:

| Matrix item             | Runner          | Output artifact              |
| ----------------------- | --------------- | ---------------------------- |
| `agentsync-linux-x64`   | `ubuntu-latest` | `dist/agentsync-linux-x64`   |
| `agentsync-macos-arm64` | `macos-latest`  | `dist/agentsync-macos-arm64` |

### Inputs (Read from Repository)

| Input                           | Source                             | Used by              |
| ------------------------------- | ---------------------------------- | -------------------- |
| `release-please-config.json`    | repo root                          | `release-please` job |
| `.release-please-manifest.json` | repo root                          | `release-please` job |
| Bun version                     | `bun-version: "1.3.9"` (hardcoded) | `build-and-upload`   |
| Bun dependency cache            | `~/.bun/install/cache` (restored)  | `build-and-upload`   |
| `bun.lock` (for cache key)      | repo root                          | `build-and-upload`   |
| GITHUB_TOKEN                    | `secrets.GITHUB_TOKEN`             | both jobs            |

### Outputs (Written / Mutated)

| Output               | Written by           | Consumed by                                    |
| -------------------- | -------------------- | ---------------------------------------------- |
| Release PR           | `release-please` job | human reviewer → merge → tag                   |
| GitHub Release + tag | `release-please` job | `build-and-upload` job (via `tag_name` output) |
| Binary artifacts     | `build-and-upload`   | uploaded to GitHub Release                     |
| Cache entry          | `actions/cache@v4`   | future release runs                            |

### Permissions

| Job                | Permission      | Level   | Reason                           |
| ------------------ | --------------- | ------- | -------------------------------- |
| `release-please`   | `contents`      | `write` | creates git tags and releases    |
| `release-please`   | `pull-requests` | `write` | creates the release PR           |
| `build-and-upload` | `contents`      | `write` | uploads binary to GitHub Release |

### Repository-Level Permission Requirement

The `release-please` job requires the repository setting
**"Allow GitHub Actions to create and approve pull requests"** to be **enabled**.

This overrides the default GitHub setting (`can_approve_pull_request_reviews: false`).
Without this, GITHUB_TOKEN cannot create PRs even when the workflow declares
`pull-requests: write`.

**Required API state (post-fix)**:

```json
GET /repos/chrisleekr/agentsync/actions/permissions/workflow
{
  "default_workflow_permissions": "read",
  "can_approve_pull_request_reviews": true
}
```
