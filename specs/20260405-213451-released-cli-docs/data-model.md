# Data Model: Released CLI Documentation Refresh

**Branch**: `20260405-213451-released-cli-docs` | **Date**: 2026-04-05

This feature is documentation-only, but it still has a concrete design model so coverage and consistency can be reviewed deliberately instead of by intuition.

---

## Entity 1 — Documentation Surface

Represents a repository-hosted page that can guide the reader toward the released CLI path or the contributor-from-source path.

### Documentation Surface Fields

- **Path**: repository-relative Markdown path
- **Primary Audience**: released user, contributor, maintainer, or mixed
- **Primary Purpose**: installation, usage, maintenance, troubleshooting, or routing
- **Execution Scope**: released path, source path, or explicit redirect between them
- **Canonical Release Reference**: whether the page points to GitHub Releases
- **Consistency Obligations**: the wording promises that must stay aligned with adjacent pages

### Instances In Scope

- `README.md`
- `docs/command-reference.md`
- `docs/development.md`
- `docs/maintenance.md`
- `docs/troubleshooting.md`

---

## Entity 2 — Reader Intent

Represents the question a reader is trying to answer when they land in the documentation.

### Reader Intent Fields

- **Intent Name**: installation, first verification, command usage, source development, maintenance review, troubleshooting
- **Preferred Entry Surface**: the page that should answer the question first
- **Fallback Surface**: the page that should receive redirected readers
- **Failure Mode**: the kind of confusion caused by incorrect routing

### Intent Mapping

- **Install released CLI** → `README.md`, then `docs/command-reference.md`
- **Use released commands** → `docs/command-reference.md`
- **Develop from source** → `docs/development.md`
- **Maintain release-path docs** → `docs/maintenance.md`
- **Troubleshoot command execution** → `docs/troubleshooting.md`

---

## Entity 3 — Execution Path

Represents the command shape a page is describing.

### Execution Path Fields

- **Path Name**: released CLI path or contributor-from-source path
- **Invocation Pattern**: command prefix used on the page
- **When To Use**: the conditions that make this path correct
- **Out-Of-Scope Rule**: what the page must not imply about the other path

### Instances

#### Released CLI Path

- **Invocation Pattern**: `bunx --package @chrisleekr/agentsync agentsync <command> [options]`
- **When To Use**: published versions that are available through npm and GitHub Releases
- **Out-Of-Scope Rule**: must not imply contributor setup from a local clone

#### Contributor-From-Source Path

- **Invocation Pattern**: `bun run src/cli.ts <command> [options]`
- **When To Use**: local development, unreleased work, and contributor verification
- **Out-Of-Scope Rule**: must not be presented as the default path for released users

---

## Entity 4 — Canonical Release Reference

Represents the single source of truth for released version and change information.

### Canonical Release Reference Fields

- **Surface**: GitHub Releases
- **Purpose**: version lookup, release notes, release existence confirmation
- **Linked From**: pages that reference the released CLI path

### Rule

Any page that tells readers how to install or use the released CLI must either link directly to GitHub Releases or direct readers to a page that does.

---

## Entity 5 — Manual Validation Step

Represents a reviewer action required by the documentation-only exception.

### Manual Validation Step Fields

- **Target Surface**: page being reviewed
- **Validation Goal**: what must be confirmed
- **Expected Outcome**: wording or routing that should be visible

### Required Steps

1. Confirm `README.md` shows install or invocation, first verification, and when-to-use wording for the released CLI path.
2. Confirm `docs/command-reference.md` teaches released command usage consistently.
3. Confirm `docs/development.md`, `docs/maintenance.md`, and `docs/troubleshooting.md` preserve clear released-versus-source boundaries.
4. Confirm all affected pages retain GitHub Releases as the canonical release-information source.
