# Maintenance Guide

## Purpose

Use this guide when a change affects user-facing behavior, exported symbols, sync semantics, or platform behavior and you need to know which docs and JSDoc must change with it.

## Documentation ownership rules

- `README.md` is the entry point, not the full manual.
- `docs/development.md` owns contributor setup and local workflow.
- `docs/architecture.md` owns system structure, flow, and security boundaries.
- `docs/command-reference.md` owns command contracts and support-state notes.
- `docs/troubleshooting.md` owns failure cases and next diagnostic steps.
- This page owns upkeep rules and review checkpoints.

## Release workflow ownership rules

- The GitHub Release record created by release-please is the canonical release-information surface.
- The npm publish path must use GitHub OIDC trusted publishing only.
- Long-lived npm write tokens are not a supported normal-release credential model for this repo.
- User-facing documentation must not present `bunx` installation as supported until release validation succeeds for that workflow.

## Publish workflow checklist

Before merging a release-surface change, verify:

1. `.nvmrc`, `package.json` Volta pin, and workflow Node version expectations still align.
2. `.github/workflows/release-please.yml` grants `id-token: write` and `contents: read` to the publish job.
3. The publish job upgrades npm to `11.5.1` or later when required.
4. No step relies on `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or equivalent long-lived npm publish secrets.
5. `README.md` and `docs/command-reference.md` point users to the GitHub Release record for version and change information.
6. `bun run build:package`, `bun run pack:dry-run`, and `bun run check` all pass.

## When docs must be updated

Update repository docs in the same change when you:

- add or remove a CLI command or subcommand
- change required inputs, defaults, or outcomes for an existing workflow
- change how the released CLI is installed or how release notes are surfaced
- alter agent support, path resolution, daemon behavior, or vault semantics
- introduce a new platform-specific caveat
- change secret-handling or recipient expectations

## JSDoc expectations

- All exported functions, classes, interfaces, and types in production source need concise JSDoc.
- Maintained internal production helpers should also have JSDoc when they carry workflow or safety meaning.
- Prefer one summary sentence and one short rationale or constraint sentence when needed.
- Use `@param`, `@returns`, and `@throws` when they add signal rather than noise.
- Treat stale JSDoc as a defect, not as optional cleanup.

## Review checklist

Before merging, verify:

1. README still routes readers to the right guide within one screenful.
2. Command changes are reflected in `docs/command-reference.md`.
3. Setup or recovery changes are reflected in `docs/development.md` or `docs/troubleshooting.md`.
4. Architecture-sensitive changes are reflected in `docs/architecture.md`.
5. Exported production symbols changed by the PR have updated JSDoc.
6. Support-state wording is explicit where behavior is partial, planned, or unsupported.
7. `README.md` and `docs/command-reference.md` still point to the canonical GitHub Release record for release notes.
8. `bun run check` still passes.

## Terminology guardrails

- Use **vault** for the encrypted Git repository, not “backup folder” or “storage layer.”
- Use **snapshot** for reading local state into artifacts.
- Use **apply** for writing decrypted vault state onto the machine.
- Use **recipient** for an age public key that can decrypt the vault.
- Use **daemon** for the background auto-sync process.

## Scope boundary for JSDoc work

- Production modules under `src/` are in scope.
- Files under `src/**/__tests__/` are not the primary documentation target for this feature.
- Maintained support code under `src/test-helpers/` stays in scope when it is part of the supported development surface.

## Related docs

- [architecture.md](architecture.md)
- [development.md](development.md)
- [command-reference.md](command-reference.md)
- [troubleshooting.md](troubleshooting.md)
