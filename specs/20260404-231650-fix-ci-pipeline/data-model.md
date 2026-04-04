# Data Model: Fix CI Pipeline

**Branch**: `20260404-231650-fix-ci-pipeline` | **Date**: 2026-04-04

This feature involves no application data model changes. The schema under management is the
GitHub Actions workflow job dependency graph — the "data" here is the ordering and
dependency relationships between CI jobs.

---

## CI Workflow Job Graph (After Fix)

### `ci.yml` — Current (broken) vs Target

**Current state**: three parallel, independent jobs (no ordering):

```
push/PR → lint ─┐
             test ─┤  (all run simultaneously, wasted compute on lint failure)
            build ─┘
```

**Target state**: sequential pipeline with gated execution:

```
push/PR → lint → test → build
              ↓failure   ↓failure
            (stop)      (stop)
```

### Entity: GitHub Actions Job

| Field         | Type     | Description                                      |
| ------------- | -------- | ------------------------------------------------ |
| `name`        | string   | Human-readable job label                         |
| `runs-on`     | string   | Runner OS (`ubuntu-latest`)                      |
| `needs`       | string[] | Upstream job IDs that must pass before this runs |
| `permissions` | map      | Per-job token permission grants                  |
| `steps`       | Step[]   | Ordered list of actions and shell commands       |

### Entity: Bun Version Pin

| Location                      | Field          | Before  | After   |
| ----------------------------- | -------------- | ------- | ------- |
| `.bun-version`                | (file content) | absent  | `1.3.9` |
| `ci.yml` → lint job           | `bun-version`  | `1.2.9` | `1.3.9` |
| `ci.yml` → test job           | `bun-version`  | `1.2.9` | `1.3.9` |
| `ci.yml` → build job          | `bun-version`  | `1.2.9` | `1.3.9` |
| `release-please.yml` → build  | `bun-version`  | `1.2.9` | `1.3.9` |
| `release-please.yml` → upload | `bun-version`  | `1.2.9` | `1.3.9` |

### Entity: Repository Permission Setting

| Setting API field                  | Before  | After  | UI location                                                                               |
| ---------------------------------- | ------- | ------ | ----------------------------------------------------------------------------------------- |
| `default_workflow_permissions`     | `read`  | `read` | unchanged                                                                                 |
| `can_approve_pull_request_reviews` | `false` | `true` | Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" |

### Entity: Dependency Cache Step

Present in `ci.yml` for all three jobs — template to be replicated into
`release-please.yml`'s `build-and-upload` job:

```yaml
- name: Cache bun dependencies
  uses: actions/cache@v4
  with:
    path: ~/.bun/install/cache
    key: ${{ runner.os }}-bun-${{ hashFiles('bun.lock') }}
    restore-keys: |
      ${{ runner.os }}-bun-
```

---

## State Transitions

### Job Execution States

```
not-triggered → queued → in-progress → success
                                     ↘ failure (skip all downstream `needs:` dependents)
                                     ↘ cancelled (newer push via concurrency cancel)
```

### Cache States

```
cold (no cache) → install all deps → write cache
warm (cache hit) → restore cache → skip install (near-instant)
stale (bun.lock changed) → cache miss → install all deps → overwrite cache
```

---

## Package Version Diff (FR-010 – FR-014)

All dependency upgrades adopted in this feature branch. Source changes: **zero** —
every upgrade is a drop-in compatible version bump (plus automated `biome migrate`).

### Direct Dependencies (`dependencies`)

| Package          | File           | Current   | Target   | Source Changes?                                                |
| ---------------- | -------------- | --------- | -------- | -------------------------------------------------------------- |
| `zod`            | `package.json` | `^3.23.8` | `^4.0.0` | None — all schemas already use Zod v4 API                      |
| `@clack/prompts` | `package.json` | `^0.9.0`  | `^1.2.0` | None — no spinner usage; `log.*`/`intro`/`outro` API unchanged |
| `citty`          | `package.json` | `^0.1.6`  | `^0.2.2` | None — `defineCommand`/`runMain` API unchanged                 |

### Dev Dependencies (`devDependencies`)

| Package          | File           | Current    | Target         | Source Changes?                                                      |
| ---------------- | -------------- | ---------- | -------------- | -------------------------------------------------------------------- |
| `@biomejs/biome` | `package.json` | `^1.9.4`   | `^2.0.0`       | `biome.json` — run `npx @biomejs/biome migrate --write` (automated)  |
| `typescript`     | `package.json` | `^5.8.3`   | `^6.0.0`       | None — `tsc` runs `--noEmit` only; Bun native bundler used for build |
| `@types/node`    | `package.json` | `^22.15.3` | latest `^22.x` | None                                                                 |

### GitHub Actions

| Action             | File                      | Current | Target | YAML Changes?                              |
| ------------------ | ------------------------- | ------- | ------ | ------------------------------------------ |
| `actions/checkout` | `ci.yml` (×3)             | `@v4`   | `@v6`  | Ref only (`@v4` → `@v6`); no input changes |
| `actions/checkout` | `release-please.yml` (×2) | `@v4`   | `@v6`  | Ref only (`@v4` → `@v6`); no input changes |

### New Files

| File                    | Content                                                               | Purpose                                                           |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `.bun-version`          | `1.3.9`                                                               | Pins Bun runtime for local/CI parity; read by `oven-sh/setup-bun` |
| `bunfig.toml` (updated) | `coverageThreshold = { lines = 0.9, functions = 0.9 }` under `[test]` | Hard-gates CI on 90% coverage                                     |
