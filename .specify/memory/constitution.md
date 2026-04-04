<!-- Sync Impact Report
  Version change: 1.1.0 → 1.2.0
  Modified principles:
    - None renamed
  Added sections: None
  Modified sections:
    - Development Workflow: Branch strategy bullet expanded to mandate
      timestamp naming (YYYYMMDD-HHMMSS-<slug>) and prohibit sequential
      numeric prefixes for new branches.
  Removed sections: None
  Templates requiring updates:
    - .specify/templates/plan-template.md ✅ updated ([###-feature-name] → [YYYYMMDD-HHMMSS-feature-name])
    - .specify/templates/spec-template.md ✅ updated ([###-feature-name] → [YYYYMMDD-HHMMSS-feature-name])
    - .specify/templates/tasks-template.md ✅ updated ([###-feature-name] → [YYYYMMDD-HHMMSS-feature-name])
    - .specify/init-options.json ⚠️ pending: "branch_numbering" should be changed from "sequential" to "timestamp"
  Follow-up TODOs:
    - TODO(INIT_OPTIONS): Update .specify/init-options.json "branch_numbering" from "sequential" to "timestamp"
      so new project scaffolding respects this convention by default.
-->

# AgentSync Constitution

## Core Principles

### I. Security-First Credential Handling

All data that leaves the local machine MUST be encrypted at rest using
age X25519 public-key encryption (via the `age-encryption` library).
Private keys (identities) MUST never be committed to the vault
repository or logged to any output stream.

- The `NEVER_SYNC_PATTERNS` list in `src/core/sanitizer.ts` is the
  single source of truth for files that MUST be excluded from sync.
  Any file matching a pattern in that list MUST be blocked before
  encryption, not after.
- Secret-value regex patterns in `sanitizer.ts` MUST be applied to
  file content before packaging. Detected secrets MUST cause the
  operation to abort with a clear error, not silently redact.
- Encryption recipients MUST be explicitly configured in
  `agentsync.toml`; implicit or default keys are forbidden.
- New file types added to agent snapshots MUST be reviewed against
  `NEVER_SYNC_PATTERNS` and the secret-value regexes before merging.
- Age identity strings MUST only be read from the local keyfile path
  and MUST never appear in CLI output, logs, or IPC messages.

### II. Test Coverage (NON-NEGOTIABLE)

Every module that handles credentials, encryption, sanitization, or
config parsing MUST have unit tests. The project uses `bun test` as
its sole test runner.

- Security-critical modules (`encryptor.ts`, `sanitizer.ts`,
  `config/schema.ts`) MUST maintain ≥90% line coverage.
- All other modules MUST maintain ≥70% line coverage.
- New features MUST include tests that exercise both the success path
  and at least one error/edge-case path before the PR is mergeable.
- Test files MUST be placed in a `__tests__/` subdirectory within the
  same directory as the module they test, using the `*.test.ts` naming
  convention (e.g. `src/core/__tests__/git.test.ts` for `src/core/git.ts`).
- Coverage is measured via `bun test --coverage`. The CI pipeline
  (`bun run check`) MUST pass before any merge.

### III. Cross-Platform Daemon Reliability

The AgentSync daemon MUST operate correctly on macOS, Linux, and
Windows. Platform-specific code MUST be isolated into dedicated
installer modules (`installer-macos.ts`, `installer-linux.ts`,
`installer-windows.ts`).

- The daemon MUST communicate with the CLI exclusively through the
  Unix domain socket / named pipe abstracted by `src/core/ipc.ts`.
- File-system watchers MUST use `node:fs` `watch` (via Bun's Node
  compat layer) rather than Bun-specific APIs to maximise portability.
- All watcher callbacks MUST be debounced (minimum 300 ms quiet period)
  to collapse rapid editor saves into a single push cycle.
- The daemon MUST handle `SIGTERM` and `SIGINT` gracefully: close the
  IPC socket, flush pending operations, then exit with code 0.
- Platform-specific paths (e.g., `~/Library/LaunchAgents` on macOS,
  `~/.config/systemd/user` on Linux) MUST be resolved through
  `src/config/paths.ts`, never hard-coded in business logic.

### IV. Code Quality with Biome

Biome is the sole linter and formatter. ESLint, Prettier, and other
formatting tools MUST NOT be added to the project.

- `bunx biome ci .` MUST pass with zero errors in CI. Warnings for
  `noExplicitAny` and `noConsoleLog` are permitted only in daemon
  bootstrap code (`src/daemon/index.ts`).
- All runtime data structures that cross a trust boundary (config
  files, IPC messages, CLI arguments) MUST be validated with Zod
  schemas defined in `src/config/schema.ts`.
- `useConst` and `noUnusedVariables` rules are enforced at error
  level; no suppression comments are allowed for these rules.
- Import ordering is managed by Biome's `organizeImports`; manual
  import sorting MUST NOT be performed.

### V. JSDoc Documentation Standards

All exported functions, classes, interfaces, and types MUST have JSDoc
comments. Documentation MUST be concise — a single sentence stating
_what_ the symbol does — and MUST explain _why_ it exists and any
non-obvious behaviour or constraints.

- `@param`, `@returns`, and `@throws` tags MUST be present for public
  API functions that have multiple parameters, non-void return values,
  or documented error conditions.
- Internal (non-exported) helpers are RECOMMENDED to have JSDoc when
  logic is non-trivial, but it is not strictly required.
- Documentation MUST be updated in the same commit as any change that
  alters a symbol's observable behaviour, signature, or semantics.
  Stale JSDoc is treated as a documentation defect.
- Auto-derived types (e.g., `z.infer<typeof Schema>`) are exempt from
  inline JSDoc but MUST have a one-line comment at the declaration site
  identifying the source schema.
- `@deprecated` MUST be applied to any symbol scheduled for removal
  and MUST include a brief migration note pointing to the replacement.

## Technology Constraints

- **Runtime**: Bun ≥1.x. Node.js APIs are used via Bun's compat
  layer; direct Node.js execution is not a supported target.
- **Language**: TypeScript in strict mode (`"strict": true` in
  `tsconfig.json`). `any` MUST be avoided; use `unknown` with
  Zod parsing for external data.
- **Encryption**: `age-encryption` (X25519). No other encryption
  library or scheme MUST be introduced without a constitution
  amendment.
- **Git operations**: `simple-git`. Shell-exec of `git` is forbidden.
- **Schema validation**: Zod. JSON Schema or manual validation MUST
  NOT replace Zod for config or IPC message parsing.
- **CLI framework**: `citty`. Interactive prompts use `@clack/prompts`.
- **Packaging**: `tar` (npm package) for archive operations.
- **Git hooks**: Lefthook. Husky or lint-staged MUST NOT be added.

## Development Workflow

- **Pre-commit gate**: Lefthook runs `bun run typecheck` and
  `bunx biome ci .` on every commit. Commits that bypass these
  checks (e.g., `--no-verify`) MUST NOT be pushed to shared branches.
- **CI gate**: `bun run check` (typecheck → lint → test) MUST pass
  on every PR before merge.
- **Commit messages**: Follow Conventional Commits (`feat:`, `fix:`,
  `docs:`, `chore:`, `refactor:`, `test:`). Releases are driven by
  `release-please`.
- **Branch strategy**: Feature branches off `main` MUST use timestamp
  naming: `YYYYMMDD-HHMMSS-<slug>` (e.g.,
  `20260404-130000-my-feature`). Pass `--timestamp` when creating
  branches via the `create-new-feature` script. Sequential numeric
  prefixes (`001-`) MUST NOT be used for new branches; they cause
  numbering collisions when multiple developers work in parallel.
  Direct pushes to `main` are forbidden.
- **Dependency additions**: New runtime dependencies MUST be justified
  in the PR description. Security-sensitive dependencies (crypto,
  network, fs) require explicit review of the package's maintenance
  status and known vulnerabilities before adoption.
- **Documentation gate**: Every PR that adds or modifies an exported
  symbol MUST include up-to-date JSDoc for those symbols (Principle V).
  Reviewers MUST reject PRs where JSDoc is absent or describes outdated
  behaviour. Documentation updates MUST land in the same commit as the
  implementation change — not as a follow-up.

## Governance

This constitution supersedes all ad-hoc practices. Every PR and code
review MUST verify compliance with the principles above.

- **Amendments**: Any change to this constitution MUST be proposed as
  a standalone PR with the rationale documented in the PR description.
  Amendments MUST be approved before merging.
- **Versioning**: The constitution follows semantic versioning.
  MAJOR = principle removal or backward-incompatible redefinition.
  MINOR = new principle or materially expanded guidance.
  PATCH = clarifications, typo fixes, non-semantic refinements.
- **Compliance review**: At least once per quarter, the team MUST
  audit the codebase against these principles and file issues for any
  drift discovered.
- **Conflict resolution**: If a spec, plan, or task contradicts this
  constitution, the constitution takes precedence. The conflicting
  artifact MUST be amended to align.

**Version**: 1.2.0 | **Ratified**: 2026-04-04 | **Last Amended**: 2026-04-04
