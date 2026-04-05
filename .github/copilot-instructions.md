# agent-sync Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-04-05

## Active Technologies
- YAML (GitHub Actions workflow DSL) + `oven-sh/setup-bun@v2` (Bun `1.3.9`), `actions/checkout@v4`, (20260404-231650-fix-ci-pipeline)
- TypeScript 5.8.3 → 6.x (strict mode; `any` forbidden — use `unknown` + Zod) + Bun 1.3.9, `citty ^0.2.2`, `@clack/prompts ^1.2.0`, `zod ^4.0.0` (20260404-231650-fix-ci-pipeline)
- N/A (file-system only; no database) (20260404-231650-fix-ci-pipeline)
- TypeScript 6.x (strict mode) plus Markdown documentation + Bun 1.3.9, `citty ^0.2.2`, `@clack/prompts ^1.2.0`, `simple-git ^3.27.0`, `zod ^4.0.0` (20260405-091845-improve-project-docs)
- N/A for runtime; repository-hosted Markdown files and source comments only (20260405-091845-improve-project-docs)
- TypeScript 6.0.0 (strict) with Bun 1.3.9 runtime; Node 22.14.0+ and npm 11.5.1+ for npm trusted publishing + Bun 1.3.9, `citty`, `simple-git`, `zod`, release-please, GitHub Actions, npm registry trusted publishing via OIDC (20260405-112827-bunx-release)
- N/A for runtime data; repository files, GitHub Releases, and npm registry package metadata (20260405-112827-bunx-release)
- TypeScript 6.0.0 (strict) with Bun 1.3.9 runtime; Node 22.14.0+ and npm 11.5.1+ for trusted publishing + Bun 1.3.9, `citty`, `simple-git`, `zod`, release-please, GitHub Actions, npm registry trusted publishing via OIDC (20260405-112827-bunx-release)
- Markdown documentation plus TypeScript 6.0.0 repository contex + Existing repo toolchain only; authoritative research sources are official spec-kit documentation and the `github/spec-kit` repository (20260405-195011-speckit-dev-docs)
- Repository-hosted Markdown files under `README.md`, `docs/`, `.github/`, and `.specify/` as referenced documentation sources (20260405-195011-speckit-dev-docs)
- Markdown documentation plus TypeScript 6.x and Bun 1.3.9 repository contex + Existing repo toolchain only; no new runtime or documentation dependencies (20260405-213451-released-cli-docs)
- Repository-hosted Markdown files and feature-planning artifacts only (20260405-213451-released-cli-docs)

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
- 20260405-213451-released-cli-docs: Added Markdown documentation plus TypeScript 6.x and Bun 1.3.9 repository contex + Existing repo toolchain only; no new runtime or documentation dependencies
- 20260405-195011-speckit-dev-docs: Added Markdown documentation plus TypeScript 6.0.0 repository contex + Existing repo toolchain only; authoritative research sources are official spec-kit documentation and the `github/spec-kit` repository
- 20260405-112827-bunx-release: Added TypeScript 6.0.0 (strict) with Bun 1.3.9 runtime; Node 22.14.0+ and npm 11.5.1+ for trusted publishing + Bun 1.3.9, `citty`, `simple-git`, `zod`, release-please, GitHub Actions, npm registry trusted publishing via OIDC


<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
