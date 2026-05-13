---
name: log-summariser
description: Collapse noisy logs into a short incident-grade summary.
---

# Log Summariser

Given a log excerpt:

1. Identify distinct error classes; collapse repeated lines.
2. Surface the first and last occurrence timestamps.
3. Highlight any 5xx, OOM, or panic frames.

Output is a 5-bullet summary followed by a single proposed next step.
