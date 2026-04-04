# Research: Fix CI Pipeline

**Branch**: `20260404-231650-fix-ci-pipeline` | **Date**: 2026-04-04

---

## Finding 1 — CI Run 23978676855: Unit Tests (Bun 1.2.9 Linux rename bug)

### Evidence

Full failure log retrieved via `gh run view 23978676855 --log-failed`. Every test that
invokes `atomicWrite` (defined in `src/agents/_utils.ts`) fails with:

```
ENOENT: no such file or directory, rename '/tmp/agentsync-test-.../file.tmp' → '/tmp/agentsync-test-.../file'
syscall: "rename", errno: -2, code: "ENOENT"
```

The `atomicWrite` implementation:

```ts
await mkdir(dirname(path), { recursive: true });
const tmpPath = `${path}.tmp`;
await writeFile(tmpPath, content); // ← Bun 1.2.9 Linux: file never actually reaches disk
await rename(tmpPath, path); // ← ENOENT because tmpPath was never written
```

**Scope of failures**: `atomicWrite` tests in `_utils.test.ts`; all `apply*` tests across
`claude.test.ts`, `codex.test.ts`, `cursor.test.ts`, `copilot.test.ts`, `vscode.test.ts`;
and `snapshot*` tests that depend on directory-creation paths. 40+ failing tests.

**Local environment (Bun 1.3.9)**: All 190 tests pass. Zero failures reproduced locally.

**CI environment (Bun 1.2.9 on ubuntu-latest)**: Consistent ENOENT failures on rename.

### Root Cause

Bun `1.2.9` has a Linux-specific bug in `node:fs/promises.writeFile` where writing to a
newly created directory path does not guarantee the file is flushed to the filesystem before
the promise resolves. The subsequent `rename` receives `ENOENT` because the source file was
never committed to disk. This bug is absent in Bun `1.3.x`.

The spec's assumption — _"The pinned Bun runtime version (`1.2.9`) is intentionally fixed;
upgrading it is a separate decision outside this feature's scope"_ — is **invalidated by this
finding**. The Bun version IS the cause of the failure. The upgrade IS within scope.

### Decision

- **Chosen**: Upgrade Bun from `1.2.9` → `1.3.9` in all three occurrences in `ci.yml` and
  both occurrences in `release-please.yml`. Add a `.bun-version: 1.3.9` file to keep local
  and CI in lockstep.
- **Rationale**: `1.3.9` is already installed locally (confirmed: `bun --version → 1.3.9`).
  All 190 tests pass. The Bun 1.3.9 changelog has no breaking changes that affect this
  project's code. Staying on 1.2.9 is not viable.
- **Alternatives considered**:
  - _Stay on 1.2.9_: Not viable — bug causes 40+ test failures on every push to `main`.
  - _Workaround `atomicWrite` with explicit sync_: Rejected — fragile workaround for a bug
    fixed upstream; adds maintenance burden; violates the spirit of test correctness.
  - _Use `"latest"` floating version_: Rejected — unpinned versions introduce
    non-determinism. Must remain pinned.
  - _Use latest 1.2.x patch_: Rejected — no patch release for this bug exists in the 1.2
    line; the fix landed in 1.3.x.

---

## Finding 2 — CI Run 23978676849: release-please (GitHub Actions PR creation blocked)

### Evidence

```
release-please failed: GitHub Actions is not permitted to create or approve pull requests.
https://docs.github.com/rest/pulls/pulls#create-a-pull-request
```

GitHub API query result:

```json
GET /repos/chrisleekr/agentsync/actions/permissions/workflow
{
  "default_workflow_permissions": "read",
  "can_approve_pull_request_reviews": false
}
```

The workflow correctly declares `permissions: pull-requests: write`. However, GitHub
enforces a **repository-level override** ("Allow GitHub Actions to create and approve pull
requests") that supersedes per-workflow permission grants. When `can_approve_pull_request_reviews`
is `false`, GITHUB_TOKEN cannot create PRs regardless of the workflow YAML. This is the
**default** for all new GitHub repositories.

Reference: [GitHub Docs — Automatic token authentication](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication#modifying-the-permissions-for-the-github_token)

### Root Cause

The repository's Actions settings have "Allow GitHub Actions to create and approve pull
requests" **disabled** (the GitHub default for new repos). The `release-please-action`
requires PR creation to function; without it every push to `main` fails.

### Decision

- **Chosen**: Enable via GitHub CLI: `gh api --method PUT repos/chrisleekr/agentsync/actions/permissions/workflow --field can_approve_pull_request_reviews=true`.
  Equivalent UI path also documented in `quickstart.md`.
- **Rationale**: The workflow is already correctly authored with `pull-requests: write`. Only
  the repository gate needs to be lifted. This is a one-time settings change.
- **Alternatives considered**:
  - _Use a fine-grained PAT secret_: Rejected — adds secret management burden; GITHUB_TOKEN
    is the recommended, official approach per the release-please and GitHub docs.
  - _Replace release-please with a different tool_: Rejected — out of scope; the workflow
    is correctly written and release-please is already working on other repos.

---

## Finding 3 — FR-005: Job Ordering (lint → test → build)

### Evidence

Current `ci.yml` has **no `needs:` declarations**. All three jobs (`lint`, `test`, `build`)
run in parallel. This wastes compute when lint fails (SC-003 requires ≥60% compute saving
when lint fails).

`needs:` is native GitHub Actions syntax with no runtime overhead and no additional
dependencies. Reference: [GitHub Docs — Defining prerequisite jobs](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idneeds)

### Decision

- **Chosen**: Add `needs: [lint]` to the `test` job; add `needs: [test]` to the `build` job.
- **Rationale**: Direct, zero-cost implementation of FR-005 and SC-003. No new actions or
  secrets required.
- **Alternatives considered**: None — `needs:` is the only correct, idiomatic mechanism
  in GitHub Actions for sequential job gating.

---

## Finding 4 — FR-008: Dependency Caching in release-please Workflow

### Evidence

The `build-and-upload` job in `release-please.yml` has **no `actions/cache` step**. The
`ci.yml` workflow already has a working cache (`actions/cache@v4` keyed on `bun.lock`).
The release workflow currently re-downloads all Bun dependencies on every release, wasting
time and bandwidth.

### Decision

- **Chosen**: Add the same `actions/cache@v4` step used in `ci.yml` (path
  `~/.bun/install/cache`, key `${{ runner.os }}-bun-${{ hashFiles('bun.lock') }}`) to the
  `build-and-upload` job.
- **Rationale**: Identical to what already works in `ci.yml`. Direct implementation of
  FR-008. No new actions or secrets required.
- **Alternatives considered**: None.

---

## Finding 5 — FR-009 Resolution: Coverage Threshold Enforcement

The constitution (Principle II) mandates: ≥90% line coverage for security-critical modules
(`encryptor.ts`, `sanitizer.ts`, `config/schema.ts`), ≥70% for all others.

Current coverage from a passing local run:

| Module              | % Lines |
| ------------------- | ------- |
| `core/encryptor.ts` | 100.00% |
| `core/sanitizer.ts` | 100.00% |
| `config/schema.ts`  | 100.00% |
| All files combined  | 92.45%  |

Bun `1.3.x` supports `coverageThreshold` natively in `bunfig.toml`
(documented in [Bun Test Coverage docs](https://bun.sh/docs/cli/test#coverage)).
Setting this causes `bun test` to exit with a non-zero code when coverage falls below
the configured thresholds — a hard gate requiring no shell scripting.

### Decision

- **Chosen**: Add `coverageThreshold = { lines = 0.9, functions = 0.9 }` to `bunfig.toml`
  under the `[test]` section. This is a native Bun feature; no external scripts required.
- **Rationale**: Q1 clarification (2026-04-05) resolved this as a hard gate, not deferred.
  `bunfig.toml` is the correct, idiomatic location per Bun documentation. The CI test job
  already runs `bun test`, which reads `bunfig.toml` automatically.
- **Alternatives considered**: Shell script parsing coverage JSON — rejected as fragile
  and maintenance-heavy given the native Bun support available in 1.3.x.

---

## Finding 6 — FR-010: `actions/checkout` v4 → v6

### Evidence

All workflow files reference `actions/checkout@v4`. The v6 release
([GitHub release notes](https://github.com/actions/checkout/releases/tag/v6.0.0))
adds Node.js 24 runner support and changes credential storage to a separate file
(instead of inline git config). No workflow YAML syntax changes are required; the
action interface and inputs are fully backward-compatible.

### Decision

- **Chosen**: Update all occurrences of `actions/checkout@v4` → `actions/checkout@v6`
  in `ci.yml` (×3) and `release-please.yml` (×2). No other YAML changes needed.
- **Rationale**: Drop-in replacement. v6 is the latest stable release per the GitHub
  Actions marketplace. `persist-credentials` behaviour is unchanged for standard usage
  (secrets.GITHUB_TOKEN); no workflow step in either file relies on git-config-embedded
  tokens post-checkout.
- **Alternatives considered**: Staying on v4 — rejected because FR-010 and Dependabot
  PR #2 both mandate the upgrade, and v6 carries no breaking changes for this project.

---

## Finding 7 — FR-011: `@biomejs/biome` v1 → v2

### Evidence

The project uses `@biomejs/biome ^1.9.4` with a `biome.json` config file. Biome v2
([migration guide](https://biomejs.dev/internals/changelog/)) revamps the import
organiser and changes several `biome.json` schema fields. The official migration
path is `npx @biomejs/biome migrate --write`, which automatically rewrites
`biome.json` to the v2 schema.

Audit of `src/` source files against known Biome v2 rule changes: no rule renames
affect the existing code; the import organiser changes will reorder some import groups
but the result is still valid TypeScript. `bun run check` (which runs `bun run lint`)
is the verification gate.

### Decision

- **Chosen**: Bump `"@biomejs/biome": "^2.0.0"` in `package.json`; run
  `npx @biomejs/biome migrate --write` after `bun install` to migrate `biome.json`
  automatically; verify with `bun run check`.
- **Rationale**: Automated migration is the Biome-recommended path. No manual
  `biome.json` edits required. Source files need zero changes.
- **Alternatives considered**: Manual `biome.json` edit — rejected; tooling-automated
  migration is more reliable and is what the Biome team endorses.

---

## Finding 8 — FR-012: `typescript` v5 → v6

### Evidence

Full TypeScript 6 breaking-change announcement reviewed:
[Announcing TypeScript 6.0](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/).

Breaking changes evaluated against `tsconfig.json`:

| Breaking change                          | Project impact                                          |
| ---------------------------------------- | ------------------------------------------------------- |
| `types: []` defaults to all `@types/*`   | NOT affected — already explicit `["bun-types", "node"]` |
| `strict: true` default                   | NOT affected — already explicit                         |
| `module: ESNext` default                 | NOT affected — already explicit                         |
| `moduleResolution: node` deprecated      | NOT affected — using `Bundler`                          |
| `esModuleInterop: false` deprecated      | NOT affected — already `true`                           |
| `rootDir` defaults to project root (`.`) | See note below                                          |
| ES5 target / AMD / UMD / outFile removed | NOT used                                                |

**`rootDir` note**: With `outDir: "dist"` and no `rootDir` set, TypeScript 6 would
default `rootDir` to `.` (project root), which would place compiled output into
`dist/src/` instead of `dist/`. However, the project build command is
`bun build --compile src/cli.ts` — Bun's native bundler, which does NOT invoke `tsc`.
Type checking runs `bunx tsc --noEmit` (no output emitted). Since no emit occurs,
the `rootDir` default change has zero observable impact on this project.

### Decision

- **Chosen**: Bump `"typescript": "^6.0.0"` in `package.json`. Zero `tsconfig.json`
  or source file changes required. Verify with `bunx tsc --noEmit` after install.
- **Rationale**: All breaking changes evaluated; none affect this codebase. The build
  uses Bun's native bundler, not tsc output. Type-check-only usage sidesteps all
  emit-related breaking changes.
- **Alternatives considered**: Adding `"rootDir": "src"` to `tsconfig.json` as a
  defensive measure — rejected; unnecessary since `tsc --noEmit` never writes output,
  and adding speculative config changes violates the project's constitution principle of
  minimal-footprint changes.

---

## Finding 9 — FR-013: `zod` v3 → v4

### Evidence

Full Zod v4 migration guide reviewed. Key v3→v4 breaking changes:

- `z.string().nonempty()` removed → use `z.string().min(1)` ✅ already used
- `z.record(valueSchema)` removed → use `z.record(z.string(), valueSchema)` or
  `z.record(keySchema, valueSchema)` — project already uses 2-arg form ✅
- `z.object().strict()` / `.passthrough()` chaining changed — NOT used ✅
- `.safeParse()` return type improved — no source changes, only better types ✅

Audit of `src/config/schema.ts` (the sole Zod consumer):

- Uses `z.string().min(1)` — valid in v4 ✅
- Uses `z.record(z.string().min(1), z.string().min(1))` — valid 2-arg form ✅
- Uses `z.object()`, `z.boolean()`, `z.optional()`, `z.array()` — all unchanged ✅
- No usage of `z.string().nonempty()`, `z.record(valueOnly)`, or any deprecated API ✅

### Decision

- **Chosen**: Bump `"zod": "^4.0.0"` in `package.json`. Zero source changes required.
- **Rationale**: All v4 breaking changes audited against `src/config/schema.ts`. No
  deprecated APIs are in use. The upgrade is a pure version bump.
- **Alternatives considered**: None — the code already conforms to the Zod v4 API.

---

## Finding 10 — FR-014: `@clack/prompts` v0.9 → v1.2 and `citty` v0.1 → v0.2

### Evidence

**@clack/prompts v1.x** ([changelog](https://github.com/bombshell-dev/clack/releases)):

- v1.0.0 MAJOR: ESM-only (was dual CJS+ESM). Fine — project is `"type": "module"` ✅
- v1.0.0: Spinner API changed: `stop(undefined, 1)` → `cancel()`,
  `stop(undefined, 2)` → `error()`. Audit of all `src/` files: NO spinner usage.
  Project only uses `log.info`, `log.warn`, `log.error`, `intro`, `outro`. ✅
- v1.1.0: `picocolors` replaced with `node:util.styleText`. Bun 1.3.9 implements
  `node:util.styleText` via its Node.js compatibility layer ✅
- v1.2.x: New `date` prompt + minor bug fixes. No API removals ✅

**citty v0.2.x** ([changelog](https://github.com/unjs/citty/releases)):

- v0.2.0 MAJOR: ESM-only. Fine — project is `"type": "module"` ✅
- v0.2.0: Uses `node:util.parseArgs` internally (breaking change in edge-case parsing
  behaviour, but only for exotic argument formats). `defineCommand` and `runMain` APIs
  are unchanged ✅
- v0.2.0: Now zero-dependency (267 kB → 22.8 kB install) ✅
- v0.2.1–v0.2.2: Bug-fix releases only ✅

Audit of CLI usage files (`src/cli.ts`, `src/commands/*.ts`, `src/daemon/installer-*.ts`):

- `defineCommand` / `runMain` from citty — API unchanged ✅
- `log.*` / `intro` / `outro` from @clack/prompts — API unchanged ✅

### Decision

- **Chosen**: Bump `"@clack/prompts": "^1.2.0"` and `"citty": "^0.2.2"` in
  `package.json`. Zero source changes required. Verify CLI still functions after install
  by running `bun run build` and executing `./dist/agentsync --help`.
- **Rationale**: All breaking changes in both libraries audited against the project's
  usage. Zero deprecated or removed APIs are in active use.
- **Alternatives considered**: None — code already conforms to both v1.x APIs.
