# agent-sync Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-04-05

## Active Technologies
- YAML (GitHub Actions workflow DSL) + `oven-sh/setup-bun@v2` (Bun `1.3.9`), `actions/checkout@v4`, (20260404-231650-fix-ci-pipeline)
- TypeScript 5.8.3 → 6.x (strict mode; `any` forbidden — use `unknown` + Zod) + Bun 1.3.9, `citty ^0.2.2`, `@clack/prompts ^1.2.0`, `zod ^4.0.0` (20260404-231650-fix-ci-pipeline)
- N/A (file-system only; no database) (20260404-231650-fix-ci-pipeline)
- TypeScript 6.x (strict mode) plus Markdown documentation + Bun 1.3.9, `citty ^0.2.2`, `@clack/prompts ^1.2.0`, `simple-git ^3.27.0`, `zod ^4.0.0` (20260405-091845-improve-project-docs)
- N/A for runtime; repository-hosted Markdown files and source comments only (20260405-091845-improve-project-docs)

- TypeScript 5.8+ (strict mode; `any` forbidden — use `unknown` + Zod) + `bun:test` (built-in), `age-encryption ^0.3.0`, `simple-git ^3.27.0`, `tar ^7.4.0`, `zod ^3.23.8`, `@iarna/toml ^2.2.5` (001-initial-function-testing)

## Project Structure

```text
src/
tests/
```

## Commands

npm test && npm run lint

## Code Style

TypeScript 5.8+ (strict mode; `any` forbidden — use `unknown` + Zod): Follow standard conventions

## Recent Changes
- 20260405-091845-improve-project-docs: Added TypeScript 6.x (strict mode) plus Markdown documentation + Bun 1.3.9, `citty ^0.2.2`, `@clack/prompts ^1.2.0`, `simple-git ^3.27.0`, `zod ^4.0.0`
- 20260404-231650-fix-ci-pipeline: Added TypeScript 5.8.3 → 6.x (strict mode; `any` forbidden — use `unknown` + Zod) + Bun 1.3.9, `citty ^0.2.2`, `@clack/prompts ^1.2.0`, `zod ^4.0.0`
- 20260404-231650-fix-ci-pipeline: Added YAML (GitHub Actions workflow DSL) + `oven-sh/setup-bun@v2` (Bun `1.3.9`), `actions/checkout@v4`,


<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
