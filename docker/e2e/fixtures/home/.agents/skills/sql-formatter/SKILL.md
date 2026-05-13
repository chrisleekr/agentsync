---
name: sql-formatter
description: Format SQL statements to the project's house style.
---

# SQL Formatter

User-scope Codex skill stored under `~/.agents/skills/`.

Rules:

- Keywords uppercase, identifiers lowercase.
- One column per line in `SELECT` lists over 80 chars.
- Trailing commas allowed in CTEs for cleaner diffs.
