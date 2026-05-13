---
name: json-explainer
description: Walks through unfamiliar JSON payloads and explains each field.
---

# JSON Explainer

Use when a user pastes an unfamiliar JSON blob and asks "what is this".

Steps:

1. Identify the top-level shape (object, array, primitive).
2. Annotate each key with a one-line meaning hypothesis.
3. Flag any field that looks like a secret and refuse to echo it.
