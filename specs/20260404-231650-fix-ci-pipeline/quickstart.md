# Quickstart: Fix CI Pipeline

**Branch**: `20260404-231650-fix-ci-pipeline` | **Date**: 2026-04-04  
**Applies to**: `.github/workflows/ci.yml`, `.github/workflows/release-please.yml`

This guide walks through the four concrete changes needed to fix both failing CI pipelines.
Complete them in order — Step 1 is a one-time repo setting change and can be done any time;
Steps 2–5 are code changes committed to the feature branch.

---

## Prerequisites

```sh
# Ensure you are on the feature branch
git checkout 20260404-231650-fix-ci-pipeline

# Verify your local Bun version (should be 1.3.9)
bun --version
```

---

## Step 1: Enable PR creation in repository settings (one-time, out-of-band)

**Root cause fixed**: `run/23978676849` — release-please fails with
"GitHub Actions is not permitted to create or approve pull requests."

**Option A — GitHub CLI (recommended)**:

```sh
gh api \
  --method PUT \
  repos/chrisleekr/agentsync/actions/permissions/workflow \
  --field can_approve_pull_request_reviews=true
```

Verify:

```sh
gh api repos/chrisleekr/agentsync/actions/permissions/workflow
# Expected: "can_approve_pull_request_reviews": true
```

**Option B — UI**:

1. Go to **https://github.com/chrisleekr/agentsync/settings/actions**
2. Scroll to **Workflow permissions**
3. Tick **"Allow GitHub Actions to create and approve pull requests"**
4. Click **Save**

> **Note**: This change takes effect immediately and applies globally to all workflows.
> It is repository-level state, not tracked in source control.

---

## Step 2: Create `.bun-version` file

Pin the Bun version at the repository root so `bun` installs are consistent between
local development and CI.

```sh
echo "1.3.9" > .bun-version
```

This file is read automatically by `oven-sh/setup-bun@v2` and by local `bun` installations
that support the `.bun-version` convention.

---

## Step 3: Update `.github/workflows/ci.yml`

Two changes:

1. Bump all three `bun-version` pins from `"1.2.9"` → `"1.3.9"` (fixes `run/23978676855`)
2. Add `needs:` ordering so jobs run `lint` → `test` → `build` (FR-005)

The file has three jobs: `lint`, `test`, `build`. Edit as follows:

**`lint` job** — no `needs:` (it is the root). Only change the Bun version:

```yaml
- uses: oven-sh/setup-bun@v2
  with:
    bun-version: "1.3.9" # was "1.2.9"
```

**`test` job** — add `needs:` and bump Bun:

```yaml
  test:
    runs-on: ubuntu-latest
    needs: [lint]               # ← ADD THIS LINE
    steps:
      ...
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.9"  # was "1.2.9"
```

**`build` job** — add `needs:` and bump Bun:

```yaml
  build:
    runs-on: ubuntu-latest
    needs: [test]               # ← ADD THIS LINE
    steps:
      ...
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.9"  # was "1.2.9"
```

---

## Step 4: Update `.github/workflows/release-please.yml`

Two changes:

1. Bump Bun version from `"1.2.9"` → `"1.3.9"` in the `build-and-upload` job (FR-001)
2. Add a `actions/cache@v4` step to the `build-and-upload` job before `bun install` (FR-008)

**Bun version** — the `release-please` job does not install Bun; only `build-and-upload` does.
Find the `setup-bun` step in `build-and-upload` and change:

```yaml
- uses: oven-sh/setup-bun@v2
  with:
    bun-version: "1.3.9" # was "1.2.9"
```

**Cache step** — add this step **after** `checkout` and `setup-bun`, **before** `bun install`:

```yaml
- name: Cache bun dependencies
  uses: actions/cache@v4
  with:
    path: ~/.bun/install/cache
    key: ${{ runner.os }}-bun-${{ hashFiles('bun.lock') }}
    restore-keys: |
      ${{ runner.os }}-bun-
```

The full job step order should be:

1. `actions/checkout@v4`
2. `oven-sh/setup-bun@v2`
3. `actions/cache@v4` ← newly added
4. `bun install --frozen-lockfile`
5. `bun run build`
6. upload artifact step(s)

---

## Step 5: Verify locally

```sh
# Run linter + type check
bun run lint

# Run all tests (should show 190 passing, 0 failing)
bun test --coverage

# Confirm no compile errors
bun run build
```

Expected test output:

```
190 pass
0 fail
coverage: ~92% lines, ~97% functions
```

---

## Step 6: Push and open PR

```sh
git add .bun-version .github/workflows/ci.yml .github/workflows/release-please.yml
git commit -m "fix(ci): upgrade Bun to 1.3.9, fix job ordering, add release caching"
git push origin 20260404-231650-fix-ci-pipeline
```

Then open a PR targeting `main` on GitHub. Confirm:

- CI passes (lint → test → build, all green)
- Branch pipeline shows sequential job execution (test waits for lint, build waits for test)

---

## Verification Checklist

After the PR is merged to `main`:

- [ ] Next commit to `main` triggers CI — all three jobs pass
- [ ] `test` job does NOT start until `lint` passes
- [ ] `build` job does NOT start until `test` passes
- [ ] New PR opened against `main` → release-please workflow runs → release PR created (or
      updated) successfully
- [ ] `build-and-upload` job shows cache hit on second run
- [ ] `gh api repos/chrisleekr/agentsync/actions/permissions/workflow` returns
      `"can_approve_pull_request_reviews": true`
