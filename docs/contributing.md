---
description: Contribute to AgentSync, set up from source, run the verification loop, follow release discipline, and keep the documentation from drifting.
---

# Contributing

Develop AgentSync from a clone, run the verification loop, follow the release discipline, and keep the docs from drifting.

## What this page owns

This page owns three things: the contributor setup loop, the release rules, and the doc-ownership table that drives the docs drift check in CI. If a contributor-facing rule exists, it lives here.

## When to read this

Read this page if you are:

- developing AgentSync from a local clone instead of using the published CLI,
- shipping a release through release-please,
- changing anything under `docs/` or anything the docs describe.

If you are running AgentSync as an end user, start at [Home](index.md) and read [Commands](commands.md) and [Operations](operations.md) instead.

## Develop from source

Clone the repo and verify the toolchain first.

```bash
git clone git@github.com:chrisleekr/agentsync.git
cd agentsync
bun install
bun run check
```

`bun run check` runs typecheck, Biome lint, the docs-mirror check, and the test suite (in that order). A clean run is the precondition for opening a pull request.

While developing, run the CLI directly from source rather than the global install so your changes take effect immediately:

```bash
bun run src/cli.ts <command>
```

Common loops:

Documentation commands require Python 3.10 or newer.

```bash
bun test                                              # full test suite
bun test --watch src/core/__tests__/git.test.ts       # focus one file in watch mode
bun run typecheck                                     # tsc --noEmit
bun run lint                                          # biome ci .
bun run lint:fix                                      # biome check --write .
bun run check:docs                                    # docs-mirror drift check only
bun run docs:serve                                    # mkdocs serve at http://127.0.0.1:8000
bun run docs:build                                    # mkdocs build --strict
```

The Lefthook hooks run on commit and push. They invoke the same checks `bun run check` does, so a passing local check is also a passing pre-push hook.

## Release discipline

Releases are cut by [release-please](https://github.com/googleapis/release-please) from Conventional Commit messages on `main`. The release-please PR collects every change since the previous release, bumps the version, and updates the CHANGELOG. Merging that PR publishes the GitHub Release and triggers the npm publish workflow.

Rules:

- The GitHub Release record is the canonical surface for "what changed" and "which version". Docs link there rather than duplicating release notes.
- npm publish uses GitHub OIDC trusted publishing only. Long-lived npm write tokens are not a supported credential model for this repo.
- Before merging any release-surface change verify: `.nvmrc`, the `package.json` Volta pin, and the CI workflow Node version still align; `release-please.yml` grants `id-token: write` and `contents: read` to the publish job; `bun run build:package`, `bun run pack:dry-run`, and `bun run check` all pass.

Versioning is semver. The pre-1.0 caveat in [Home](index.md#project-status) applies until 1.0 lands.

## Working on the TUI

The interactive TUI lives in `src/commands/tui/`. The boundary is strict:

- `app.ts` owns the renderer lifecycle, the tab router, and the global key
  router. Tabs and wizards do not touch the renderer directly.
- Each tab module exposes `renderXxx(renderer, host, state)` and, where it
  is interactive, `onXxxKey(key, state): boolean` — `true` means the state
  changed and a rerender is needed.
- All business logic is reused from the existing command modules
  (`performInit`, `performKeyAdd`, `performKeyRotate`, `performMigrate`,
  `performSkillRemove`). The TUI must not fork encryption, reconciliation,
  sanitiser, or migration rules.

Local development:

```bash
bun run src/cli.ts          # bare invocation opens the TUI
bun run src/cli.ts tui      # explicit alias
echo '' | bun run src/cli.ts # forces the non-TTY fallback (status text)
```

Compiled binary verification (`dist/agentsync`):

```bash
bun run build               # runs scripts/build.ts (with --os=* --cpu=*)
./dist/agentsync            # macOS Gatekeeper may kill an unsigned binary;
                            #   prefer `bun install -g @chrisleekr/agentsync`
                            #   or run via source for development.
```

The npm-published bundle (`dist/cli.js`) externalises `@opentui/core` so
the single-file bundle stays a single file. Consumers pick up the native
TUI dependency from the `dependencies` block in `package.json` at install
time.

## Doc ownership

Single source of truth for which file owns which concept. The docs-mirror CI check (`scripts/check-docs-mirror.ts`, wired into `bun run check`) parses this table and fails the PR if drift appears.

| Page | Owner | Source of truth in code | Trigger to update |
|---|---|---|---|
| `index.md` | maintainer | repo root, `package.json`, install paths | release flow change, install-method change, project-status change |
| `architecture.md` | maintainer | `src/core/`, `src/migrate/`, `src/agents/` | new module, new invariant, security-boundary change, vault-format version bump |
| `commands.md` | maintainer | `src/cli.ts`, `src/commands/` | new command, new flag, exit-code change, outcome change |
| `migrate.md` | maintainer | `src/migrate/`, `src/agents/` | new agent, new config type, new MCP transport |
| `operations.md` | maintainer | troubleshooting reports | new failure mode |
| `contributing.md` | maintainer | `package.json` scripts, `lefthook.yml`, `biome.json`, `.github/workflows/` | new tooling, release-rule change, ownership change |

Rule: if a fact appears in two pages, the page in the table is the owner. The other page links to it instead of restating it. PRs that change a fact must touch only the owner.

The docs-mirror check enforces three things:

1. Every `*.md` file in `docs/` appears in this table.
2. Every row in this table corresponds to an existing file.
3. Every `docs/<file>.md` link in `README.md` and `CLAUDE.md` points at a file that exists.

The third rule is what catches dead links from `README.md` or `CLAUDE.md` to a `docs/*.md` page that does not exist — strict mkdocs builds only validate links inside the nav, so those slip through otherwise.

## Doc conventions

- **Anchors are stable.** Prefer `## Install`, `## Push`, `## Recover from divergence` over restructured headings. External links from blog posts and Slack survive only if anchors do.
- **Diagrams use Mermaid** with the existing dark-fill `classDef` palette and the `.agentsync-darknodes` wrapper so labels stay readable in both colour schemes.
- **Code samples are commands and config**, not implementation. The docs describe what a command does and how to use it; the source is the source of truth for *how* it does it.
- **Each page opens with "What this page owns"** so a reader can tell within a paragraph whether they are in the right place.

## PR checklist

Before opening a PR:

- [ ] `bun run check` is green locally.
- [ ] Every changed CLI surface is reflected in `docs/commands.md` (or `docs/migrate.md` for migrate-only changes).
- [ ] Every change that crosses a security or reconciliation boundary is reflected in `docs/architecture.md`.
- [ ] If a doc file moved or was deleted, every internal link to it still resolves; `mkdocs build --strict` proves this in CI.

The maintainer reviewing the PR uses the doc-ownership table to decide whether the docs change is necessary, sufficient, and in the right file.
