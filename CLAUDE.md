# agent-sync Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-04-11

## Active Technologies
- TypeScript 6.x, strict mode (`"strict": true`) + citty 0.2.x (CLI), @clack/prompts 1.2.x (output), @iarna/toml ^2.2.5 (Codex TOML), zod 4.x (validation) (20260406-125441-config-migration)
- Local filesystem only (agent config files via `AgentPaths` from `src/config/paths.ts`) (20260406-125441-config-migration)
- TypeScript 6.x, strict mode + citty 0.2.x (CLI), @clack/prompts 1.2.x (output), zod 4.x (validation), simple-git 3.x, age-encryption 0.3.x, picocolors 1.1.x (new explicit dep) (20260406-164513-repo-housekeeping)
- Local filesystem (agent config files via `AgentPaths`) (20260406-164513-repo-housekeeping)
- TypeScript 6.x, strict mode (`"strict": true`), Bun ≥ 1.3.9 runtime + `citty` (CLI), `@clack/prompts` (output), `tar` v7 (archive), `age-encryption` (X25519 encryption), `simple-git` (vault Git ops), `zod` (schema validation), `picocolors` (terminal colours) (20260411-002222-agent-skills-sync)
- Local filesystem only. Skill sources at `~/.claude/skills/`, `~/.cursor/skills/`, `~/.codex/skills/`, `~/.copilot/skills/`. Encrypted destinations at `<vaultDir>/<agent>/skills/<name>.tar.age`, wired through `AgentPaths` in `src/config/paths.ts` (20260411-002222-agent-skills-sync)

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
- 20260411-002222-agent-skills-sync: Added TypeScript 6.x, strict mode (`"strict": true`), Bun ≥ 1.3.9 runtime + `citty` (CLI), `@clack/prompts` (output), `tar` v7 (archive), `age-encryption` (X25519 encryption), `simple-git` (vault Git ops), `zod` (schema validation), `picocolors` (terminal colours)
- 20260406-164513-repo-housekeeping: Added TypeScript 6.x, strict mode + citty 0.2.x (CLI), @clack/prompts 1.2.x (output), zod 4.x (validation), simple-git 3.x, age-encryption 0.3.x, picocolors 1.1.x (new explicit dep)
- 20260406-125441-config-migration: Added TypeScript 6.x, strict mode (`"strict": true`) + citty 0.2.x (CLI), @clack/prompts 1.2.x (output), @iarna/toml ^2.2.5 (Codex TOML), zod 4.x (validation)


<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
