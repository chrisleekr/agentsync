# AgentSync

AgentSync is a Bun-based CLI daemon that syncs AI agent global configuration files to an encrypted Git vault.

## Current implementation status

This repository currently includes a Phase 1 baseline:

- Core config loading and schema validation
- Secret redaction and hard exclusions
- Claude agent snapshot and apply flow
- CLI commands: `init`, `push`, `pull`, `status`, `doctor`
- CI workflow with typecheck, lint, and Bun tests

## Quick start

```bash
bun install
bun run typecheck
bun run test
bun run lint
```

Initialize:

```bash
bun run src/cli.ts init --remote git@github.com:<you>/agentsync-vault.git --branch main
```

Push Claude artifacts:

```bash
bun run src/cli.ts push --agent claude
```

Pull Claude artifacts:

```bash
bun run src/cli.ts pull --agent claude
```
