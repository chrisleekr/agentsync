# agent-sync Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-04-06

## Active Technologies
- TypeScript 6.x, strict mode (`"strict": true`) + citty 0.2.x (CLI), @clack/prompts 1.2.x (output), @iarna/toml 2.2.x (Codex TOML), zod 4.x (validation) (20260406-125441-config-migration)
- Local filesystem only (agent config files via `AgentPaths` from `src/config/paths.ts`) (20260406-125441-config-migration)

- TypeScript 6.x, strict mode (`"strict": true`) + citty 0.2.x, @clack/prompts 1.2.x, zod 4.x, simple-git 3.x, age-encryption 0.3.x (20260406-094347-stabilise-daemon)

## Project Structure

```text
src/
tests/
```

## Commands

bun run check

## Code Style

TypeScript 6.x, strict mode (`"strict": true`): Follow standard conventions

## Recent Changes
- 20260406-125441-config-migration: Added TypeScript 6.x, strict mode (`"strict": true`) + citty 0.2.x (CLI), @clack/prompts 1.2.x (output), @iarna/toml 2.2.x (Codex TOML), zod 4.x (validation)

- 20260406-094347-stabilise-daemon: Added TypeScript 6.x, strict mode (`"strict": true`) + citty 0.2.x, @clack/prompts 1.2.x, zod 4.x, simple-git 3.x, age-encryption 0.3.x

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
