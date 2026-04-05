# Quickstart: Released CLI Documentation Refresh

**Branch**: `20260405-213451-released-cli-docs` | **Date**: 2026-04-05

This quickstart gives the implementation order and manual validation sequence for aligning the released CLI documentation across every affected page.

---

## Prerequisites

```sh
git checkout 20260405-213451-released-cli-docs
bun install
```

---

## Step 1 — Audit Every Related Documentation Surface

Review:

1. `README.md`
2. `docs/command-reference.md`
3. `docs/development.md`
4. `docs/maintenance.md`
5. `docs/troubleshooting.md`

Capture where each page currently answers or fails to answer:

- how to invoke the released CLI
- how to use it for common commands
- when to use the released path instead of the contributor-from-source path
- where to look up released version and change information

Expected result: a concrete wording gap list rather than vague “docs need cleanup” conclusions.

---

## Step 2 — Fix The Released User Entry Path

Update `README.md` so a first-time reader can answer these questions immediately:

1. What is the released CLI path?
2. How do I verify it resolves correctly?
3. How do I run common commands through the published package?
4. When should I use this path instead of the contributor docs?

Expected result: the entry page becomes sufficient for installation and first use orientation.

---

## Step 3 — Align Command Usage And Supporting Guides

Update:

1. `docs/command-reference.md` to teach released command usage consistently.
2. `docs/development.md` to keep source workflow guidance explicit and redirect released users.
3. `docs/maintenance.md` to define the docs that must stay aligned when the released path changes.
4. `docs/troubleshooting.md` to prevent source-only command examples from misleading released users.

Expected result: no deep-linked doc page leaves the released-versus-source boundary implicit.

---

## Step 4 — Validate Documentation-Only Compliance

Run:

```sh
bun run check
```

Then manually verify:

1. `README.md` contains released install or invocation guidance, first verification, and when-to-use wording.
2. `docs/command-reference.md` shows how to use the released command path and uses the published invocation pattern consistently.
3. `docs/development.md` explicitly scopes itself to contributor-from-source workflow and redirects released users appropriately.
4. `docs/maintenance.md` lists the released-path docs that must stay aligned and preserves GitHub Releases as the canonical release-information source.
5. `docs/troubleshooting.md` clearly scopes its source-based command examples and tells released users how to translate or redirect those commands.
6. No page implies that an unpublished version is available through the released path.

Expected result: the feature remains documentation-only and reviewers can confirm the consistency manually in a few minutes.

---

## Completion Criteria

- Every affected documentation surface gives consistent guidance for installation, usage, and when-to-use decisions around the released CLI path.
- Released users are not forced into contributor-from-source commands by mistake.
- The docs still use GitHub Releases as the single release-information source.
- `bun run check` passes before merge.
