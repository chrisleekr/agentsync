# Contract: Released CLI Documentation Surface

**Branch**: `20260405-213451-released-cli-docs` | **Date**: 2026-04-05

This contract defines the observable documentation behavior for the released CLI path: where readers learn how to install or invoke the published CLI, how they learn to use it, and how they decide whether they should follow the released path or the contributor-from-source path.

---

## Contract 1 — README Entry Experience

### Required Elements

| Element                | Requirement                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| Released path intro    | `README.md` must explain that the released CLI path depends on a published version                      |
| Invocation pattern     | `README.md` must show the `bunx --package @chrisleekr/agentsync agentsync <command> [options]` pattern  |
| First verification     | `README.md` must show a successful first verification command                                           |
| When-to-use guidance   | `README.md` must say when to use the released path and when to use contributor-from-source docs instead |
| Canonical release info | `README.md` must point readers to GitHub Releases for version and change information                    |

### README Behavior

- A first-time released user should be able to identify how to invoke the published CLI and where to confirm release details without opening source-oriented docs first.
- The README must remain a navigation hub, not a full command manual.

---

## Contract 2 — Command Reference Usage Rules

### Command Reference Required Behavior

- `docs/command-reference.md` must describe the released CLI path as the supported path for published versions.
- The page must teach how released command examples map to the published invocation pattern.
- The page must keep support-state wording explicit when the released path depends on an actual published release.

### Command Reference Prohibited Behavior

- Bare command examples that appear to be directly runnable by released users without any invocation context.
- Source-oriented execution guidance presented as the default released path.

---

## Contract 3 — Supporting Guide Boundaries

### Required Pages

| Path                      | Boundary Requirement                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `docs/development.md`     | Must state that it covers contributor-from-source workflow and redirect released users to released-path docs      |
| `docs/maintenance.md`     | Must define which docs remain in sync when the released path changes                                              |
| `docs/troubleshooting.md` | Must either use released-path troubleshooting commands or clearly state that its examples assume source execution |

### Supporting Guide Behavior

- Supporting guides should redirect readers between released and source paths instead of mixing both workflows inside one unlabeled section.
- Any page that stays source-oriented must say so early enough that a released user does not follow the wrong command examples by accident.

---

## Contract 4 — Canonical Release Reference

### Canonical Release Required Behavior

- GitHub Releases is the canonical source for published version and change information.
- Pages that teach the released CLI path must preserve or point back to that source.

### Canonical Release Prohibited Behavior

- Conflicting release-information sources across entry, command, maintenance, or troubleshooting docs.

---

## Contract 5 — Documentation-Only Validation

Implementation is compliant when:

1. `README.md` teaches installation or invocation, first verification, and when-to-use rules for the released CLI path.
2. `docs/command-reference.md` teaches released command usage consistently.
3. `docs/development.md`, `docs/maintenance.md`, and `docs/troubleshooting.md` keep the released-versus-source boundary explicit.
4. All affected pages keep GitHub Releases as the canonical release-information source.
5. `bun run check` passes and the manual walkthrough in the feature quickstart confirms no contradictory wording remains.
