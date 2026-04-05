# Data Model: Release Project for Bunx Installation

**Branch**: `20260405-112827-bunx-release` | **Date**: 2026-04-05

This feature does not introduce user data storage. Its design model is the release surface:
the package manifest, publish workflow, executable artifact, toolchain pins, and validation path
that together make the CLI installable through `bunx`.

---

## Entity: Package Manifest

| Field            | Type     | Description                                  |
| ---------------- | -------- | -------------------------------------------- |
| `packageName`    | string   | Published npm package identifier             |
| `version`        | string   | User-visible release version                 |
| `private`        | boolean  | Whether npm publication is blocked           |
| `binName`        | string   | User-facing executable command               |
| `binPath`        | string   | Tarball-relative path to the executable file |
| `files`          | string[] | Explicit publish allowlist                   |
| `publishAccess`  | enum     | `public` or `restricted`                     |
| `metadataStatus` | enum     | `draft`, `publishable`, `released`           |

### Package Manifest Validation Rules

- `private` must be `false` before publish.
- `packageName` must not conflict with an existing registry package intended for this feature.
- `binPath` must resolve to a file included in the package tarball.
- `publishAccess` must be `public` for a public scoped npm package.

---

## Entity: Published CLI Entry

| Field            | Type   | Description                                      |
| ---------------- | ------ | ------------------------------------------------ |
| `commandName`    | string | CLI command users run after installation         |
| `runtime`        | enum   | `bun`                                            |
| `shebang`        | string | Shebang used by the executable                   |
| `artifactPath`   | string | Built file path committed to the package tarball |
| `sourceEntry`    | string | Source entrypoint used to produce the artifact   |
| `artifactStatus` | enum   | `missing`, `built`, `packed`, `verified`         |

### Published CLI Entry Validation Rules

- `runtime` remains `bun` for this feature.
- `shebang` must invoke Bun explicitly.
- `artifactPath` and `sourceEntry` must stay version-aligned with the CLI version output.

---

## Entity: Trusted Publish Job

| Field             | Type     | Description                                              |
| ----------------- | -------- | -------------------------------------------------------- |
| `workflowFile`    | string   | Workflow filename registered with npm trusted publishing |
| `jobName`         | string   | GitHub Actions job that performs publish                 |
| `runnerType`      | enum     | `github-hosted`                                          |
| `nodeVersion`     | string   | Exact Node version used for publishing                   |
| `npmVersion`      | string   | npm CLI version used for publishing                      |
| `permissions`     | string[] | GitHub Actions permissions required by the job           |
| `environmentName` | string   | Optional protected GitHub environment name               |
| `status`          | enum     | `planned`, `configured`, `verified`                      |

### Trusted Publish Job Validation Rules

- `permissions` must include `id-token: write` and `contents: read`.
- `runnerType` must stay `github-hosted` while relying on npm trusted publishing.
- `workflowFile` must match the exact filename configured on npm.

---

## Entity: Toolchain Pin

| Field      | Type   | Description                         |
| ---------- | ------ | ----------------------------------- |
| `tool`     | enum   | `bun`, `node`, `volta-node`         |
| `filePath` | string | File that stores the pin            |
| `version`  | string | Exact pinned version                |
| `purpose`  | string | Why the tool is pinned              |
| `audience` | enum   | `runtime`, `contributor`, `publish` |

### Required Instances

- Bun pin in `.bun-version`
- Node pin in `.nvmrc`
- Node pin in `package.json` `volta`

### Toolchain Pin Validation Rules

- Bun runtime pin and Node publish pin must not contradict the documented workflows.
- Node pins must match across `.nvmrc`, Volta, and publishing workflow.

---

## Entity: Packaging Smoke Validation

| Field         | Type     | Description                                   |
| ------------- | -------- | --------------------------------------------- |
| `testPath`    | string   | Bun test file path                            |
| `packCommand` | string   | Command used to create or inspect the tarball |
| `checks`      | string[] | Assertions performed by the validation        |
| `failureMode` | string[] | Release-blocking conditions the test catches  |
| `status`      | enum     | `planned`, `implemented`, `passing`           |

### Packaging Smoke Validation Rules

- Validation must assert that the package is publishable.
- Validation must inspect the tarball shape, not just source files.
- Validation must fail when the `bin` target is absent or metadata is inconsistent.

---

## Entity: Workflow Configuration Validation

| Field            | Type     | Description                                              |
| ---------------- | -------- | -------------------------------------------------------- |
| `testPath`       | string   | Bun test file path for workflow assertions               |
| `workflowPath`   | string   | Workflow file inspected by the validation                |
| `requiredChecks` | string[] | Security and compatibility assertions for publish config |
| `status`         | enum     | `planned`, `implemented`, `passing`                      |

### Workflow Configuration Validation Rules

- The validation must inspect `.github/workflows/release-please.yml`.
- Required checks must include GitHub-hosted runner use, `id-token: write`, `contents: read`, required Node/npm versions, and absence of token-based publish credentials.
- The test file must live under a `__tests__` directory to satisfy repository test-placement rules.

---

## Entity: Documentation Surface

| Field            | Type     | Description                                              |
| ---------------- | -------- | -------------------------------------------------------- |
| `docPath`        | string   | Repository path to the documentation file                |
| `audience`       | enum     | `user`, `contributor`, or `maintainer`                   |
| `requiredTopics` | string[] | Topics the document must cover for this feature          |
| `workflowSource` | string[] | Release artifacts or workflow steps the document mirrors |
| `status`         | enum     | `planned`, `updated`, `verified`                         |

### Documentation Surface Required Instances

- `README.md` for released-user install path separation
- `docs/development.md` for contributor toolchain expectations
- `docs/command-reference.md` for install, verification, prerequisites, and command usage
- `docs/maintenance.md` for maintainer-facing release and publish workflow upkeep

### Documentation Surface Validation Rules

- The user-facing install command must be identical in `README.md` and `docs/command-reference.md`.
- `docs/development.md` must distinguish Bun runtime expectations from Node publish-tooling expectations.
- `docs/maintenance.md` must describe OIDC-only trusted publishing and must not endorse long-lived npm tokens.
- No documentation file may claim support for `bunx` installation before the validated release path exists.

---

## Entity: Release Information Surface

| Field            | Type     | Description                                              |
| ---------------- | -------- | -------------------------------------------------------- |
| `recordSource`   | enum     | `github-release`                                         |
| `versionField`   | string   | Where the published version is shown to users            |
| `changeSummary`  | string   | Where users discover what changed in the release         |
| `discoveryPaths` | string[] | Documentation paths that point users to the release info |
| `status`         | enum     | `planned`, `published`, `verified`                       |

### Release Information Surface Validation Rules

- The canonical release-information surface must be the GitHub Release generated by the release workflow.
- The release record must expose both the version identifier and a discoverable summary of changes.
- `README.md` and `docs/command-reference.md` must tell users where to find this release-information surface.

---

## Relationships

```text
Package Manifest
 ├─ exposes → Published CLI Entry
 ├─ is published by → Trusted Publish Job
 └─ is checked by → Packaging Smoke Validation

Workflow Configuration Validation
 └─ checks → Trusted Publish Job

Toolchain Pin
 ├─ supports → Trusted Publish Job
 └─ documents → contributor environment expectations

Documentation Surface
 ├─ describes → Package Manifest
 ├─ describes → Published CLI Entry
 ├─ describes → Trusted Publish Job
 └─ points to → Release Information Surface

Release Information Surface
 └─ summarizes → Package Manifest
```

---

## State Transitions

### Package Manifest Lifecycle

```text
draft → publishable → released
```

- `draft`: metadata still blocks or misrepresents publication
- `publishable`: manifest passes tarball and publish checks
- `released`: package is published and installable through the documented command

### Packaging Validation Lifecycle

```text
planned → implemented → passing
```

- `planned`: checks identified in the plan
- `implemented`: automated validation exists in the repo
- `passing`: CI and local validation both confirm the expected package surface
