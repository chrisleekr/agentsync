# Contract: Release Surface

**Branch**: `20260405-112827-bunx-release` | **Date**: 2026-04-05

This contract defines the externally visible release interface for AgentSync once the feature is implemented: the package identity, the `bunx` install path, the publish workflow guarantees, and the contributor toolchain pins required to maintain that surface.

---

## Contract 1 — Public Package Identity

### Release Information Required Elements

| Element      | Requirement                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Package name | Public npm package must publish under `@chrisleekr/agentsync` or the final scoped equivalent chosen for the repository owner |
| CLI binary   | The user-facing command remains `agentsync`                                                                                  |
| Visibility   | Package must be published as public                                                                                          |
| Metadata     | Package must include description, repository, homepage, bugs, and license metadata                                           |

### Package Identity Behaviour

- The package identity must avoid collision with the existing unscoped `agentsync` package on npm.
- The package listing must be recognizable as the AgentSync project, not an internal build artifact.

---

## Contract 2 — Bunx Install Path

### Required Command Surface

| Command                                                    | Purpose                                    |
| ---------------------------------------------------------- | ------------------------------------------ |
| `bunx --package @chrisleekr/agentsync agentsync`           | Guaranteed documented install-and-run path |
| `bunx --package @chrisleekr/agentsync agentsync --version` | First-run verification path                |

### Bunx Install Behaviour

- The published package must expose a valid `bin` target for `agentsync`.
- The executable must be Bun-native and must retain a Bun shebang.
- Documentation must state that Bun is a prerequisite for this install path.

### Prohibited Behaviour

- Documentation must not imply that direct Node execution of the published CLI is a supported runtime contract for this feature.
- Documentation must not advertise `bunx agentsync` while the unscoped package name is unavailable.

---

## Contract 3 — Publish Workflow

### Required Workflow Behaviour

| Element         | Requirement                                                      |
| --------------- | ---------------------------------------------------------------- |
| Workflow source | Existing release-please workflow remains the release entry point |
| Publish method  | `npm publish` through npm trusted publishing                     |
| Runner type     | GitHub-hosted runner                                             |
| Permissions     | Publish job includes `id-token: write` and `contents: read`      |
| Toolchain       | Publish job uses Node `22.14.0+` and npm `11.5.1+`               |

### Publish Workflow Behaviour

- A release is not considered complete until the npm package publish step succeeds.
- Publish credentials must come from OIDC trusted publishing, not a long-lived npm write token.
- The workflow filename used by npm trusted publishing must match the actual workflow filename exactly.

---

## Contract 4 — Package Shape Validation

### Required Checks

| Check                 | Requirement                                                             |
| --------------------- | ----------------------------------------------------------------------- |
| Publish blocker check | Validation fails if `private` remains enabled                           |
| Tarball contents      | Validation confirms the published `bin` file is included                |
| Version alignment     | Validation confirms package version and CLI-reported version match      |
| File surface          | Validation confirms the tarball excludes unintended repository contents |

### Package Shape Validation Behaviour

- Validation must inspect the package tarball or an equivalent package build artifact, not just source files.
- Validation must run before public release publication.

---

## Contract 5 — Contributor Toolchain Pins

### Toolchain Required Files

| File                   | Requirement                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- |
| `.bun-version`         | Remains the Bun runtime pin                                                      |
| `.nvmrc`               | Pins the Node version used for publishing workflows and local release validation |
| `package.json` `volta` | Pins the same Node version for Volta users                                       |

### Toolchain Behaviour

- Bun and Node pins serve different purposes and must both be documented.
- The Node version in `.nvmrc`, Volta, and publish workflow must stay aligned.

---

## Contract 6 — Documentation Surface

### Documentation Required Files

| File                        | Requirement                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `README.md`                 | Separates released-user `bunx` usage from contributor setup from source                           |
| `docs/development.md`       | Explains Bun runtime usage and Node/npm publish-tooling expectations for contributors             |
| `docs/command-reference.md` | Documents the supported install command, prerequisites, verification step, and command usage      |
| `docs/maintenance.md`       | Documents the maintainer release workflow, OIDC-only trusted publishing, and release upkeep steps |

### Documentation Behaviour

- `README.md` and `docs/command-reference.md` must describe the same supported `bunx` install path.
- `README.md` and `docs/command-reference.md` must tell users where to find version-specific release notes and what changed in the installed release.
- `docs/development.md` must not blur contributor-from-source steps with released-user installation.
- `docs/maintenance.md` must describe GitHub OIDC trusted publishing as the only supported publish credential model for this feature.
- No documentation may instruct maintainers to use long-lived npm write tokens for normal release publication.

---

## Contract 7 — Release Information Surface

### Required Elements

| Element             | Requirement                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Canonical source    | The GitHub Release generated by release-please is the canonical source for release notes |
| Version visibility  | The release record clearly identifies the published version                              |
| Change visibility   | The release record includes a discoverable summary of what changed                       |
| Documentation links | `README.md` and `docs/command-reference.md` point users to the release record            |

### Release Information Behaviour

- Users must be able to determine both the installed version and what changed in that release without reading source files.
- The project must not invent a second canonical changelog surface for this feature if the GitHub Release already provides that information.

---

## Verification Surface

Implementation is compliant when:

1. The package can be published publicly without metadata blockers.
2. The documented `bunx` command launches the CLI successfully.
3. The publish workflow uses OIDC trusted publishing instead of a long-lived npm token.
4. Packaging validation catches broken `bin`, tarball, or version-surface regressions before release.
5. Contributors can reproduce the required Bun and Node toolchains across machines.
6. The four required documentation files describe a consistent and supported release workflow.
7. The GitHub Release record exposes the published version and a discoverable summary of changes, and the user docs point to it.
