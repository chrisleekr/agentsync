# Project Conventions

Coding rules live in `~/.claude/rules/coding-style.md` and the
review checklist is at `~/.claude/rules/review-checklist.md`.

## Stack

- TypeScript strict mode
- Bun runtime for tooling
- Biome for lint and format

## Conventions

- Prefer composition over inheritance.
- Tests live next to source in `__tests__/` directories.
- Run `bun run check` before pushing.

When in doubt, ask before making sweeping refactors.
