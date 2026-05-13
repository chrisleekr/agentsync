---
name: precommit-helper
description: Diagnoses lefthook failures and proposes minimal fixes.
---

When a precommit hook fails, read the stderr, identify the failing
command, and propose the smallest change that would let the hook pass
without bypassing it. Never suggest `--no-verify`.
