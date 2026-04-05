# Quickstart: Release Project for Bunx Installation

**Branch**: `20260405-112827-bunx-release` | **Date**: 2026-04-05

This guide describes the implementation and verification order for making AgentSync installable via `bunx` while keeping release behavior and contributor tooling reproducible.

---

## Prerequisites

```sh
git checkout 20260405-112827-bunx-release
bun install
```

Also confirm:

1. The npm owner or scope intended for publish exists.
2. GitHub Actions runs on hosted runners for the publish workflow.
3. The repository can use a protected environment such as `npm-publish` if approval gates are desired.

---

## Step 1 — Make The Package Publishable

1. Update `package.json` to remove the private publish blocker.
2. Choose the scoped package identity and keep the CLI bin name stable as `agentsync`.
3. Add the public package metadata needed for a usable npm listing.
4. Restrict the published file surface with `files`.

Expected result: `package.json` represents a public npm package rather than a source-only private repository manifest.

---

## Step 2 — Build A Published CLI Artifact

1. Add a dedicated package build script that emits the published executable file.
2. Keep the executable Bun-native with a Bun shebang.
3. Point the `bin` field at the built artifact.

Expected result: the package tarball contains a concrete executable path that Bun can run from `bunx`.

---

## Step 3 — Add Packaging Smoke Validation

1. Add a Bun test that inspects package metadata and tarball contents.
2. Use `npm pack` or `npm pack --dry-run` as part of the validation path.
3. Fail the validation if the package is still private, the `bin` target is missing, or the version surface is inconsistent.

Expected result: release-breaking packaging mistakes are caught before publish.

---

## Step 4 — Extend The Release Workflow

1. Add a publish job to `.github/workflows/release-please.yml`.
2. Configure `actions/setup-node`, npm CLI version, and `id-token: write` permissions.
3. Publish with `npm publish` through trusted publishing.
4. Upgrade remaining CI cache steps to `actions/cache@v5`.

Expected result: a release created by release-please also produces an installable npm package without using a long-lived npm token.

---

## Step 5 — Pin The Contributor Toolchain And Update Docs

1. Add `.nvmrc` with the exact Node publishing version.
2. Add a matching Volta pin in `package.json`.
3. Keep `.bun-version` as the Bun runtime source of truth.
4. Update `README.md` to separate released-user `bunx` usage from contributor setup from source.
5. Update `docs/development.md` to explain the split Bun runtime and Node publish toolchain expectations.
6. Update `docs/command-reference.md` with the supported install command, prerequisites, verification step, and command usage.
7. Update `docs/maintenance.md` with the OIDC-only publish flow, workflow expectations, and release upkeep steps.
8. Add links or guidance in `README.md` and `docs/command-reference.md` that tell users where to see the installed version and what changed in that release.

Expected result: users, contributors, and maintainers each have a correct document for their workflow, draft documentation is ready for validation, and no final documentation implies that source-based setup or long-lived npm tokens are the supported release path.

---

## Step 6 — Verify End To End

Run:

```sh
bun run check
```

Then verify:

1. Packaging smoke validation passes.
2. `npm pack --dry-run` shows only the intended publish surface.
3. The publish workflow contains the expected OIDC permissions.
4. The GitHub Release record for the published version exposes the version and a summary of what changed.
5. `README.md`, `docs/command-reference.md`, and `docs/maintenance.md` all describe the same install, verification, and release behavior and point to the canonical release-information surface.
6. After the first real publish, the documented command starts the released CLI and reports the expected version.

Suggested post-publish smoke command:

```sh
bunx --package @chrisleekr/agentsync agentsync --version
```

---

## Completion Criteria

- The package is publishable and no longer blocked by `private` metadata.
- The documented `bunx` command resolves the public package identity and launches the CLI.
- The release workflow publishes through OIDC without an npm token.
- The GitHub Release record is the canonical place users can see version and change information for the published release.
- `.nvmrc`, Volta, and existing Bun pinning describe a consistent contributor environment.
- `README.md`, `docs/development.md`, `docs/command-reference.md`, and `docs/maintenance.md` are consistent with the implemented release path.
- Repository verification and packaging smoke checks both pass.
