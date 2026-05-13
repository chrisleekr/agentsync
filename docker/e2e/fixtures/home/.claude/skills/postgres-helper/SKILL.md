---
name: postgres-helper
description: Diagnose and write Postgres queries against local dev databases.
---

# Postgres Helper

Use this skill when a question involves Postgres schema design,
query plans, or migrations.

## Workflow

1. Inspect the schema via `\d+ <table>`.
2. Read `reference.md` for the project's column conventions.
3. Run candidate queries through `EXPLAIN ANALYZE` before suggesting.

Seed data lives in `examples/seed.sql`.
