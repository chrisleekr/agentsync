---
name: precommit
description: Investigate and recover from lefthook precommit failures.
---

# Precommit

Use when a `git commit` is blocked by lefthook.

1. Read `lefthook.yml` to identify which hook ran.
2. Re-run the failing command in isolation to capture full output.
3. Propose a fix; do not suggest skipping hooks.
