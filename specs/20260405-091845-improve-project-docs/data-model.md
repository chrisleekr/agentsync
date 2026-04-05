# Data Model: Improve Project Documentation

**Branch**: `20260405-091845-improve-project-docs` | **Date**: 2026-04-05

This feature does not change application runtime data. Its design model is the repository
documentation system: the pages, source symbols, links, and assets that together make the project
understandable.

---

## Entity: Documentation Artifact

| Field                | Type    | Description                                                        |
| -------------------- | ------- | ------------------------------------------------------------------ |
| `path`               | string  | Repository-relative file path for the document                     |
| `audience`           | enum    | `new-user`, `operator`, `contributor`, `maintainer`, or `mixed`    |
| `purpose`            | string  | Primary question the document answers                              |
| `entryPoint`         | boolean | Whether the document is expected to be a top-level navigation page |
| `mustLinkFromReadme` | boolean | Whether the README must link to this document                      |
| `status`             | enum    | `planned`, `drafted`, `reviewed`, `published`                      |

### Validation Rules

- Every artifact must answer a single primary need.
- Only `README.md` is the primary entry point.
- Supporting guides must be linked from the README if they are required for normal project use.

---

## Entity: README Navigation Hub

Specialized documentation artifact representing `README.md`.

| Field             | Type                 | Description                                          |
| ----------------- | -------------------- | ---------------------------------------------------- |
| `logoPath`        | string               | Repository-local path to the logo asset              |
| `overviewSummary` | string               | Concise project explanation                          |
| `quickStartFlows` | string[]             | Short list of first-run workflows surfaced in README |
| `navigationLinks` | Documentation Link[] | Links to deeper guides                               |

### Validation Rules

- `logoPath` must resolve to `docs/agentsync-logo.png` unless implementation finds a rendering issue.
- README content must remain concise enough to function as an entry page rather than a full manual.
- README must link to development, architecture, maintenance, command reference, and troubleshooting guides.

---

## Entity: Supporting Guide

Specialized documentation artifact for focused documentation pages under `docs/`.

| Field              | Type                 | Description                                                                                   |
| ------------------ | -------------------- | --------------------------------------------------------------------------------------------- |
| `kind`             | enum                 | `development`, `architecture`, `maintenance`, `command-reference`, `troubleshooting`, `other` |
| `sourceOfTruthFor` | string[]             | Topics the guide owns to avoid duplication                                                    |
| `crossLinks`       | Documentation Link[] | Links to adjacent guides or README                                                            |

### Required Instances

- `docs/development.md`
- `docs/architecture.md`
- `docs/maintenance.md`
- `docs/command-reference.md`
- `docs/troubleshooting.md`

---

## Entity: JSDoc Target

| Field        | Type     | Description                                               |
| ------------ | -------- | --------------------------------------------------------- |
| `filePath`   | string   | Source file containing the symbol                         |
| `symbolName` | string   | Symbol name                                               |
| `symbolKind` | enum     | `function`, `method`, `callable-const`, `constructor`, `class`, `interface`, `type` |
| `exported`   | boolean  | Whether the symbol is exported                            |
| `hasJSDoc`   | boolean  | Whether a compliant JSDoc block exists                    |
| `needsTags`  | string[] | Any required tags such as `@param`, `@returns`, `@throws` |

### Validation Rules

- Every maintained exported TypeScript function, class, interface, and type in project source must map to a JSDoc target.
- Workflow-significant internal helpers should also map to a JSDoc target.
- Each target must have exactly one concise reasoning-led JSDoc block directly above its declaration.
- JSDoc blocks should be short enough to scan quickly and must not mechanically restate the symbol name.

---

## Entity: Documentation Link

| Field        | Type   | Description                           |
| ------------ | ------ | ------------------------------------- |
| `sourcePath` | string | Document containing the link          |
| `targetPath` | string | Linked document or asset              |
| `label`      | string | Reader-facing link label              |
| `reason`     | string | Why the reader should follow the link |

### Validation Rules

- Every required guide must have at least one inbound link from the README.
- Links should send readers to the next relevant level of detail, not to redundant content.

---

## Entity: Logo Asset

| Field     | Type     | Description                               |
| --------- | -------- | ----------------------------------------- |
| `path`    | string   | Repository-relative file path             |
| `altText` | string   | Accessibility text for Markdown rendering |
| `usedIn`  | string[] | Documents that embed the asset            |

### Validation Rules

- The logo asset must be embedded in the README with meaningful alt text.
- The logo must not be duplicated into additional binary files for this feature.

---

## Relationships

```text
README Navigation Hub
 ├─ links to → Supporting Guide: development
 ├─ links to → Supporting Guide: architecture
 ├─ links to → Supporting Guide: maintenance
 ├─ links to → Supporting Guide: command-reference
 ├─ links to → Supporting Guide: troubleshooting
 └─ embeds → Logo Asset

Supporting Guide
 └─ references → JSDoc Target coverage rules where relevant

JSDoc Target
 └─ belongs to → TypeScript source file under src/
```

---

## State Transitions

### Documentation Artifact Lifecycle

```text
planned → drafted → reviewed → published
```

- `planned`: file and purpose defined in the plan
- `drafted`: initial content written
- `reviewed`: brevity, terminology, and link consistency checked
- `published`: merged-quality content ready for implementation tasks

### JSDoc Target Lifecycle

```text
missing → drafted → normalized → verified
```

- `missing`: no compliant JSDoc exists
- `drafted`: comment added but not yet style-checked
- `normalized`: concise reasoning-led format applied
- `verified`: passes source review and project checks
