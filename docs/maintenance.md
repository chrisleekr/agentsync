# Maintenance Guide

## Purpose

Use this guide when a change affects user-facing behavior, exported symbols, sync semantics, or platform behavior and you need to know which docs and JSDoc must change with it.

## Documentation ownership rules

- `README.md` is the entry point, not the full manual.
- `docs/development.md` owns contributor setup and local workflow.
- `docs/speckit.md` owns contributor-facing spec-kit workflow order, command usage, artifact expectations, and Mermaid-backed stage flow.
- `docs/speckit-local-development.md` owns prompt-file locations, active-feature detection, timestamp branch mapping, repo-local recovery guidance, and speckit upkeep triggers.
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

- change prompt files, agent files, `.specify/` scripts, or other repo-local spec-kit workflow assets
- add or remove a CLI command or subcommand
- change required inputs, defaults, or outcomes for an existing workflow
- change how the released CLI is installed or how release notes are surfaced
- alter agent support, path resolution, daemon behavior, or vault semantics
- introduce a new platform-specific caveat
- change secret-handling or recipient expectations
- add or change a workflow, architecture, lifecycle, or interaction explanation
  that is materially clearer as a Mermaid diagram than as prose alone

## JSDoc expectations

- All exported functions, classes, interfaces, and types in production source need concise JSDoc.
- Maintained internal production helpers should also have JSDoc when they carry workflow or safety meaning.
- Prefer one summary sentence and one short rationale or constraint sentence when needed.
- Use `@param`, `@returns`, and `@throws` when they add signal rather than noise.
- Treat stale JSDoc as a defect, not as optional cleanup.

## Mermaid expectations

- Use Mermaid in repository-hosted docs when it makes a workflow, structure,
  lifecycle, or interaction easier to understand than prose alone.
- Do not add decorative diagrams that repeat surrounding text without improving clarity.
- Keep diagram labels self-explanatory so the chart is still useful when skimmed quickly.
- Validate every new or changed Mermaid diagram before merge.

## Documentation-only feature exception

- A feature may skip automated test-case additions only when every changed
  file is limited to repository-hosted documentation or feature-planning
  artifacts and the change does not alter runtime source files, exported
  symbols, configuration schemas, packaging logic, CI automation, or
  generated workflow scripts.
- Documentation-only features still need `bun run check` before merge.
- Documentation-only features still need Mermaid validation for every new
  or changed diagram.
- Documentation-only features still need manual walkthrough validation
  steps recorded in the relevant spec, plan, or quickstart artifact.

## Review checklist

Before merging, verify:

1. README still routes readers to the right guide within one screenful.
2. Spec-kit workflow changes are reflected in `docs/speckit.md` and, when local workflow behavior changed, in `docs/speckit-local-development.md`.
3. Command changes are reflected in `docs/command-reference.md`.
4. Setup or recovery changes are reflected in `docs/development.md`, `docs/speckit-local-development.md`, or `docs/troubleshooting.md`.
5. Architecture-sensitive changes are reflected in `docs/architecture.md`.
6. Exported production symbols changed by the PR have updated JSDoc.
7. Any required Mermaid diagrams were added or updated and validated successfully.
8. Documentation-only PRs that skip automated test additions record why
  the exception applies and include manual walkthrough validation steps.
9. Support-state wording is explicit where behavior is partial, planned, or unsupported.
10. `README.md` and `docs/command-reference.md` still point to the canonical GitHub Release record for release notes.
11. `bun run check` still passes.

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

- [speckit.md](speckit.md)
- [speckit-local-development.md](speckit-local-development.md)
- [architecture.md](architecture.md)
- [development.md](development.md)
- [command-reference.md](command-reference.md)
- [troubleshooting.md](troubleshooting.md)
