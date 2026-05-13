---
name: test-writer
description: Writes targeted unit tests for a function or module.
---

Given a target file, generate co-located tests in `__tests__/`.

- Use the project's existing test runner (bun test here).
- Cover happy path, one edge case, and one failure mode.
- Avoid mocking internals; prefer real fixtures.
