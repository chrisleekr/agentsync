# Quickstart: Running the Test Suite

**Feature**: `001-initial-function-testing`
**Date**: 2026-04-04

---

## Prerequisites

- Bun ≥ 1.x installed (`bun --version`)
- Dependencies installed (`bun install`)
- No external services or network access required — all tests are self-contained

Verify your setup:

```bash
cd /path/to/agent-sync
bun --version   # should print 1.x.x
bun install     # only needed once
```

---

## Run All Tests

```bash
bun test
```

Expected output pattern:

```
 src/core/encryptor.test.ts:
  ✓ generates a valid AGE identity (12ms)
  ✓ encrypts and decrypts a string roundtrip (8ms)
  ✓ encrypts and decrypts a file roundtrip (15ms)
  ...

 src/core/sanitizer.test.ts:
  ✓ redacts known secret fields (3ms)
  ...

 22 tests passed (8 suites) — 4.2s
```

---

## Run Tests with Coverage Report

```bash
bun test --coverage
```

The coverage report is printed to stdout after the test run. Check that:

- `src/core/encryptor.ts`, `src/core/sanitizer.ts`, `src/config/schema.ts` each show **≥ 90%** line coverage
- All other modules show **≥ 70%** line coverage

---

## Run a Single Test File

```bash
# Core module examples
bun test src/core/encryptor.test.ts
bun test src/core/sanitizer.test.ts
bun test src/core/tar.test.ts
bun test src/core/ipc.test.ts
bun test src/core/watcher.test.ts
bun test src/core/git.test.ts

# Config examples
bun test src/config/schema.test.ts
bun test src/config/loader.test.ts
bun test src/config/paths.test.ts

# Agent examples
bun test src/agents/claude.test.ts
bun test src/agents/copilot.test.ts

# Integration
bun test src/commands/integration.test.ts
```

---

## Run Tests Matching a Name Pattern

```bash
# Run only tests whose description contains "encrypt"
bun test --test-name-pattern "encrypt"

# Run only tests whose description contains "sanitize"
bun test --test-name-pattern "sanitize"

# Run only zip-slip tests
bun test --test-name-pattern "zip.slip"
```

---

## Full CI Gate (Typecheck + Lint + Tests)

This is what CI runs (and what Lefthook runs on commit):

```bash
bun run check
```

This is equivalent to:

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # bunx biome ci .
bun test            # all tests
```

Run this before opening a PR to catch any issues.

---

## Test Output Interpretation

| Symbol | Meaning                             |
| ------ | ----------------------------------- |
| `✓`    | Test passed                         |
| `✗`    | Test failed — full diff shown below |
| `↷`    | Test skipped (`test.skip`)          |

Failures print a unified diff of `expected` vs `received` inline. No separate reporter needed.

---

## Common Issues

### "Cannot find module 'bun:test'"

You are running tests with Node.js or a non-Bun runner. Always use `bun test`, not `npx jest` or `npx vitest`.

### Coverage is below threshold

Check the per-file coverage table output after `bun test --coverage`. Identify which lines are not covered (marked with `×`) and add targeted test cases for those paths.

### Tests fail with EACCES or ENOENT on socket path

Ensure the test creates its socket inside the per-test `tmpDir` (not at a hard-coded path). All IPC tests should use the fixture pattern in `data-model.md §2c`.

### Git tests fail with "Author identity unknown"

Set `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` in the test env, or configure them in the bare repo with `git config`:

```typescript
execSync('git config user.email "test@example.com"', { cwd: workDir });
execSync('git config user.name "Test"', { cwd: workDir });
```
