# Docs Refactor — Consolidation + MkDocs Polish

**Date**: 2026-05-15
**Owner**: chrislee
**Status**: planned

## Problem

The `docs/` folder has drifted and is no longer easy to read:

- README links to `docs/speckit.md` and `docs/speckit-local-development.md` that do not exist.
- `architecture.md` and `architecture-overview.md` overlap; cross-links are one-way.
- The push and pull pipelines are described in both `command-reference.md` and `architecture-overview.md`.
- `maintenance.md` defines ownership rules that omit speckit and `index.md`.
- Nine content files are more than the surface needs, which scatters concepts and invites future drift.
- Material nav uses the default indigo palette and does not match the violet→cyan logo.
- The README leads with `bunx agentsync`, which hides the simpler `bun install -g agentsync` path.

## Outcome

A consolidated, MkDocs-rendered docs surface where:

- Every concept has exactly one owner page.
- The Material tab bar maps 1:1 to the five canonical pages.
- The header and accent colors match the logo gradient.
- README and `docs/index.md` lead with `bun install -g agentsync`, keep `bunx` as an alternative.
- A single ownership table, plus a CI check, prevents future drift.

## Final shape

```text
docs/
  index.md            MkDocs home: pitch, install (bun -g primary, bunx alt), nav cards, project status
  architecture.md     System model, reconcile rule, push/pull, daemon, security, vault format, source map
  commands.md         Per-command contract: flags, outcomes, caveats, support state
  migrate.md          Cross-agent migration matrix, MCP transport rules (kept, already canonical)
  operations.md       Daemon install per-OS, key rotation, troubleshooting catalogue, recovery
  contributing.md     Dev setup, bun run check, release-please, speckit pointers, doc ownership, drift CI
  stylesheets/extra.css     Existing overrides plus new logo-matching nav rules
  requirements.txt          Unchanged
  agentsync-logo.png        Unchanged
```

Deleted: `architecture-overview.md`, `command-reference.md`, `daemon.md`, `development.md`, `getting-started.md`, `maintenance.md`, `troubleshooting.md`. Their content moves per the migration map below.

## Migration map

| Current | Destination |
|---|---|
| `index.md` | Rewritten in place. Install section leads with `bun install -g agentsync`. `bunx agentsync` shown as alternative. Card grid points to the five canonical pages. |
| `getting-started.md` | Collapsed into `index.md` quickstart section. Deep links sent to `commands.md` and `operations.md`. |
| `architecture-overview.md` | Lead summary merges into `architecture.md` opening. Pipeline diagrams move into `architecture.md`. File deleted. |
| `architecture.md` | Rewritten as the sole owner of system model and push/pull/skills/plugin/daemon flows. |
| `command-reference.md` | Renamed to `commands.md`. Behind-the-scenes prose trimmed; flow narrative belongs in `architecture.md`. |
| `daemon.md` | Lifecycle and per-OS install absorbed into `operations.md`. IPC/watcher internals absorbed into `architecture.md`. |
| `troubleshooting.md` | Absorbed into `operations.md` under a Troubleshooting section. All existing entries preserved with stable `#anchor` slugs so external links survive. |
| `maintenance.md` | Ownership table and review checklist absorbed into `contributing.md` under "Doc ownership and drift". |
| `development.md` | Renamed and merged into `contributing.md`. |
| `migrate.md` | Kept as is. |
| README references to `docs/speckit.md`, `docs/speckit-local-development.md` | Deleted. Replaced with one line pointing at `specs/` and the `speckit-*` skills. Detailed speckit guidance lives in `contributing.md`. |

## Content rules

- Docs are prose plus Mermaid, not code dumps. Inline TypeScript snippets are out unless they illustrate a contract the user must satisfy (for example `agentsync.toml` shape).
- Every page opens with a one-paragraph "What this page owns" so readers know if they are in the right place.
- Cross-links flow both ways. If page A links to a section in page B, page B's section header also links back to A's mention.
- Anchors are stable: prefer `## Install`, `## Push`, `## Recover from divergence` over restructured headings, so external links from blog posts and Slack survive the refactor.
- `architecture.md` keeps its existing Mermaid diagrams; new diagrams use the dark-fill classDef palette already supported by `extra.css`.

## Install order change

The npm package is published as `@chrisleekr/agentsync` (scoped). Docs lead with the
scoped global install; `bunx` stays as the alternative.

Both `README.md` and `docs/index.md` lead with:

```bash
bun install -g @chrisleekr/agentsync
agentsync init
```

Followed by an alternative block:

```bash
# No global install, useful for trying out
bunx --package @chrisleekr/agentsync agentsync init
```

All other doc references to install commands are updated to match this order.

## Theming — match nav to logo

The logo is a violet→cyan radial gradient. The Material `primary: indigo` palette does not match.

Approach: keep Material's named palette (`primary: indigo` stays for compatibility with light/dark toggles) and override the foreground variables in `docs/stylesheets/extra.css`:

```css
/* Logo-matching header and nav.
   Violet at the upper-left of the logo (~#6D28D9) into cyan at the
   lower-right (~#06B6D4). Header uses the gradient; tab strip
   resolves to the mid-stop blue so active tab contrast stays AA. */
:root {
  --md-primary-fg-color: #4F46E5;        /* mid-stop indigo, matches the logo's centre */
  --md-primary-fg-color--light: #818CF8;
  --md-primary-fg-color--dark:  #3730A3;
  --md-accent-fg-color: #06B6D4;          /* cyan accent picks up the logo's lower-right */
}

.md-header {
  background: linear-gradient(90deg, #6D28D9 0%, #4F46E5 50%, #06B6D4 100%);
}

.md-tabs {
  background: #4F46E5;
}
```

Validation: open the rendered site in both light and dark modes, confirm AA contrast against white tab labels, and confirm hover/active states remain legible.

## mkdocs.yml nav

```yaml
nav:
  - Home: index.md
  - Architecture: architecture.md
  - Commands: commands.md
  - Migrate: migrate.md
  - Operations: operations.md
  - Contributing: contributing.md
```

`strict: true` already enforces that every nav entry resolves, which catches deleted-file mistakes during refactor.

## Ownership and drift

Single source-of-truth table lives in `contributing.md`:

| Page | Owner | Source of truth in code | Trigger to update |
|---|---|---|---|
| `index.md` | maintainer | repo root, install paths | Release flow change, install method change |
| `architecture.md` | maintainer | `src/core/`, `src/daemon/`, `src/migrate/` | New module, new invariant, security boundary change |
| `commands.md` | maintainer | `src/cli.ts`, `src/commands/` | New command, new flag, exit code change |
| `migrate.md` | maintainer | `src/migrate/`, `src/agents/` | New agent, new config type, new MCP transport |
| `operations.md` | maintainer | `src/daemon/installers/`, troubleshooting | New install target, new failure mode |
| `contributing.md` | maintainer | `package.json`, `lefthook.yml`, `biome.json`, `.github/workflows/` | New tooling, release rule change, ownership change |

CI rule (`scripts/check-docs-mirror.ts`, called from existing `bun run check`):

- Parse the ownership table out of `contributing.md`.
- Fail the PR if any page listed does not exist, or any `docs/*.md` is missing from the table.
- Fail the PR if README contains a link to `docs/<file>.md` that does not exist (catches future repeats of the speckit dead-link bug).

## Acceptance criteria

- `docs/` contains exactly the six markdown files in "Final shape", plus the existing assets.
- `mkdocs build --strict` succeeds locally and in CI.
- Every link from README, CLAUDE.md, and every doc resolves.
- README and `docs/index.md` lead with `bun install -g @chrisleekr/agentsync`, then `bunx --package @chrisleekr/agentsync agentsync` as an alternative.
- Header and tab strip render in the logo-matching palette in both light and dark modes, with white text at WCAG AA contrast.
- `bun run check` runs `scripts/check-docs-mirror.ts` and exits non-zero when ownership-table drift is introduced.
- No file under `docs/` references `FR-###`, `SC-###`, `US#`, `T###`, `NC-#`, or `(research R#)`-style spec IDs (project convention from `CLAUDE.md`).

## Execution order

1. Write the new `index.md`, `architecture.md`, `commands.md`, `operations.md`, `contributing.md`. Keep migrate.md untouched.
2. Update README install order and remove dead speckit links.
3. Update `mkdocs.yml` nav.
4. Add logo-matching CSS rules to `extra.css`.
5. Add `scripts/check-docs-mirror.ts` and wire into `bun run check`.
6. Delete the seven obsolete doc files.
7. Run `mkdocs build --strict` and `bun run check`.
8. Open PR via `/pr-auto-github`.

## Out of scope

- Switching away from MkDocs Material.
- Splitting docs into subfolders (rejected in favour of single-level structure for tab clarity).
- Audience-layered docs structure (rejected — duplicates vocabulary and grows surface).
- Code-mirrored docs structure (rejected — mismatch with user mental model; drift CI idea is kept).

## Risks

- **Anchor drift** — external links that point at `troubleshooting.md#foo` or `daemon.md#bar` break when files are deleted. Mitigation: redirect via `mkdocs-redirects` plugin, or add a one-line stub file for the first release that links to the new location.
- **Header gradient on dark mode** — the linear-gradient may clash with the slate scheme. Mitigation: scope the gradient to `[data-md-color-scheme="default"]`; supply a darker variant for slate.
- **Speckit guidance regression** — moving speckit content into `contributing.md` risks burying it. Mitigation: `contributing.md` opens with a "When to read this" section that names speckit explicitly.
