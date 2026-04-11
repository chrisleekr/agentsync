# Quickstart: Sync Agents' Skills

**Feature**: 20260411-002222-agent-skills-sync
**Purpose**: The reviewer-runnable manual walkthrough that the spec's Documentation Impact section requires. This is the procedure a reviewer follows on their own machine (or two machines) to validate that the feature behaves as the spec promises. Automated tests cover most of the surface; this walkthrough is the cross-machine round trip the test suite cannot exercise inside CI.

---

## Prerequisites

- Bun ≥ 1.3.9 installed
- An AgentSync vault you control, with at least one age recipient configured
- Two machines (call them **A** and **B**) both checked out at the feature branch `20260411-002222-agent-skills-sync`. A single machine with two separate `$HOME` directories also works
- Both machines have run `bun install` and `bun run check` and seen them pass

---

## 1. Verify the new path entries exist (≈ 30 seconds)

On both machines, run:

```bash
bun -e 'import("./src/config/paths").then(m => console.log(m.AgentPaths.claude.skillsDir, m.AgentPaths.cursor.skillsDir, m.AgentPaths.codex.skillsDir, m.AgentPaths.copilot.skillsDir))'
```

**Pass**: Four paths print, ending in `.claude/skills`, `.cursor/skills`, `.codex/skills`, `.copilot/skills`.
**Fail**: Any field is `undefined` → FR-010 / R6 not in place.

---

## 2. Build a representative skills root on machine A (≈ 2 minutes)

The goal is one tmp skills root for each agent, containing the eight cases the walker must handle: real skill, dot-prefixed dir, dot-prefixed file, symlinked root, real skill with symlinked sentinel, real skill with interior symlink helper, real skill with no `SKILL.md`, and a real skill that triggers a never-sync hit (separate test — see step 5).

Pick one agent (Claude is the easiest because the path is `~/.claude/skills/`) and create the following:

```text
~/.claude/skills/
├── alpha/                   # qualifying real skill
│   ├── SKILL.md
│   └── notes.md
├── beta/                    # qualifying real skill with an interior symlink helper
│   ├── SKILL.md
│   └── helper.md -> /tmp/some-shared-helper.md     # this file should be omitted from the tar
├── gamma/                   # disqualified — SKILL.md is itself a symlink
│   └── SKILL.md -> /tmp/vendored-pool/SKILL.md
├── delta -> /tmp/vendored-pool/delta               # disqualified — top-level symlinked root
├── epsilon/                 # disqualified — no SKILL.md sentinel
│   └── README.md
├── .system/                 # disqualified — top-level dot-prefixed dir
│   └── ignored.md
└── .DS_Store                # disqualified — top-level dot-prefixed file
```

Make sure `/tmp/vendored-pool/delta/` and `/tmp/some-shared-helper.md` actually exist so the symlinks resolve. The test is "what does AgentSync do?", not "what does the OS do with broken links".

---

## 3. Run `agentsync push` and verify the vault contents (≈ 1 minute)

```bash
bun run src/cli.ts push
```

**Expected stdout**: a success line such as `Pushed 2 encrypted artifact(s).` (the `2` covers `alpha` and `beta`; everything else was correctly rejected).

Then inspect the vault directly:

```bash
ls -la "$AGENTSYNC_VAULT_DIR/claude/skills/"
```

**Pass**: Exactly two `.tar.age` files: `alpha.tar.age` and `beta.tar.age`.
**Fail (any of)**:

- A `gamma.tar.age` exists → FR-016 sentinel-symlink rejection broken (R4).
- A `delta.tar.age` exists → FR-016 outer-tier (root symlink) rejection broken.
- An `epsilon.tar.age` exists → FR-002 sentinel rule broken.
- A `.system.tar.age` or `.DS_Store.tar.age` exists → FR-017 dot-skip broken.
- Any warning printed → FR-017 / FR-016 silence requirement violated (R7).

Now decrypt and inspect `beta.tar.age` to confirm the interior-symlink rule:

```bash
bun run src/cli.ts pull            # round-trip the artifact through decrypt
ls -la ~/.claude/skills/beta/
```

**Pass**: `beta/` contains `SKILL.md`. It does NOT contain `helper.md` (the symlinked helper was correctly omitted).
**Fail**: `helper.md` is present → FR-016 inner-tier rule broken.

---

## 4. Cross-machine round trip on machine B (≈ 2 minutes)

On machine B, ensure `~/.claude/skills/` is empty:

```bash
ls ~/.claude/skills/ 2>/dev/null || echo "(empty)"
```

Then pull:

```bash
bun run src/cli.ts pull
```

**Pass**: `~/.claude/skills/alpha/` and `~/.claude/skills/beta/` now exist on machine B. `alpha/notes.md` and `beta/SKILL.md` round-tripped. `beta/helper.md` is absent on B too (proves the interior symlink was never archived in step 3).
**Fail**: Any qualifying skill missing or any disqualified skill present.

---

## 5. Never-sync inside skill — security abort path (≈ 1 minute)

On machine A, add a never-sync file inside one of the qualifying skills:

```bash
touch ~/.claude/skills/alpha/credentials.json
```

(`credentials.json` is not in the literal `NEVER_SYNC_PATTERNS` list — substitute `auth.json`, `.credentials.json`, or any other pattern actually present in `src/core/sanitizer.ts:NEVER_SYNC_PATTERNS`. As of the feature branch the canonical example is `auth.json`.)

Run push:

```bash
bun run src/cli.ts push
```

**Pass**: Push exits with non-zero status, prints an error naming the offending absolute path, and the vault `claude/skills/alpha.tar.age` is **unchanged from the previous commit** (i.e., the bad version was never written).
**Fail**: Push succeeds, or `claude/skills/alpha.tar.age` was overwritten with a new commit, or the error message does not name the offending file.

Clean up:

```bash
rm ~/.claude/skills/alpha/credentials.json
```

---

## 6. Default-additive guarantee (FR-011) — local delete is harmless (≈ 1 minute)

On machine A, delete `alpha` locally and push:

```bash
rm -rf ~/.claude/skills/alpha
bun run src/cli.ts push
```

**Pass**: Push exits 0. `Pushed 0 encrypted artifact(s).` or similar. The vault still contains `claude/skills/alpha.tar.age` from the earlier commit. Run `bun run src/cli.ts pull` and watch `~/.claude/skills/alpha/` come back from the vault.
**Fail**: The vault no longer contains `alpha.tar.age` after the push → FR-011 broken.

---

## 7. Explicit vault removal (FR-012, FR-013) — the safety escape hatch (≈ 2 minutes)

Run the new command:

```bash
bun run src/cli.ts skill remove claude alpha
```

**Pass**: Command exits 0 with `Removed claude/alpha from vault (commit <sha7>)`. The file `<vaultDir>/claude/skills/alpha.tar.age` is gone. The local directory `~/.claude/skills/alpha/` on machine A is **still present** (the command does not touch local files).
**Fail (any of)**:

- The local `~/.claude/skills/alpha/` was deleted → FR-012's "never touches local" guarantee broken.
- The vault file is still present → command did not actually remove it.
- Exit code is non-zero on success.

Now go to machine B (which still has `alpha/` locally from step 4) and pull:

```bash
bun run src/cli.ts pull
ls ~/.claude/skills/alpha/
```

**Pass**: `alpha/` is still on machine B. Pull did not delete it (FR-013).
**Fail**: `alpha/` was deleted from machine B → FR-013 broken.

Try to remove a non-existent skill:

```bash
bun run src/cli.ts skill remove claude does-not-exist
echo "exit: $?"
```

**Pass**: Exit code `1`. Error message names the resolved vault path it looked for. No Git operation occurred.
**Fail**: Exit code `0`, or an attempted commit was made.

---

## 8. Status command surfaces the new artifacts (FR-007) (≈ 30 seconds)

```bash
bun run src/cli.ts status
```

**Pass**: The output table includes one or more rows with `agent: claude` and a `file` column ending in `.claude/skills/<name>` for each currently-synced skill, with status `synced` (or `local-changed` if you've edited a skill since the last push). The format matches the existing Copilot rows.
**Fail**: No skill rows appear, or skill rows appear but in a different format from Copilot.

---

## 9. Doctor command checks the new directories (FR-008) (≈ 30 seconds)

```bash
bun run src/cli.ts doctor
```

**Pass**: The output includes a check row for each new `skillsDir` (Claude, Cursor, Codex). The check passes when the directory is readable, warns when it does not exist.
**Fail**: No new doctor rows appear at all → FR-008 not implemented.

---

## 10. Repeat steps 2–4 for Cursor and Codex (≈ 5 minutes)

Run steps 2 through 4 again with `~/.cursor/skills/` and `~/.codex/skills/`. The expected behavior is identical, with one additional Cursor-specific check:

After the Cursor push, verify that `<vaultDir>/cursor/skills-cursor/` does NOT exist:

```bash
ls "$AGENTSYNC_VAULT_DIR/cursor/skills-cursor/" 2>/dev/null && echo "FAIL" || echo "PASS"
```

**Pass**: The directory does not exist (FR-010 — Cursor skills are scoped to `~/.cursor/skills/` only).
**Fail**: Anything under `cursor/skills-cursor/` exists in the vault.

For Codex, additionally verify the dot-skip rule applies to your machine's actual `~/.codex/skills/.system/` if it exists:

```bash
ls "$AGENTSYNC_VAULT_DIR/codex/skills/" | grep -F .system && echo "FAIL" || echo "PASS"
```

**Pass**: No `.system*` artifact in the vault.
**Fail**: Any `.system`-named artifact present.

---

## 11. Smoke-test the Copilot retrofit (≈ 2 minutes)

This is the regression check that ensures the walker swap did not change Copilot behavior for non-symlink skills. On machine A:

```bash
mkdir -p ~/.copilot/skills/zeta
echo "# zeta" > ~/.copilot/skills/zeta/SKILL.md
ln -s /tmp/vendored-pool/old-skill ~/.copilot/skills/eta   # symlink — must be skipped now
bun run src/cli.ts push
ls "$AGENTSYNC_VAULT_DIR/copilot/skills/"
```

**Pass**: `zeta.tar.age` exists. `eta.tar.age` does NOT exist.
**Fail**: `eta.tar.age` exists → Copilot retrofit broken.

---

## Final cleanup

```bash
rm -rf ~/.claude/skills/{alpha,beta,gamma,delta,epsilon,.system,.DS_Store}
rm -rf ~/.cursor/skills/{alpha,beta,gamma,delta,epsilon,.system,.DS_Store}
rm -rf ~/.codex/skills/{alpha,beta,gamma,delta,epsilon,.system,.DS_Store}
rm -rf ~/.copilot/skills/{zeta,eta}
rm -rf /tmp/vendored-pool /tmp/some-shared-helper.md
```

If any test machine still has `~/.claude/skills/` populated with your real skills, do NOT run the cleanup blindly — only remove the fixture names you created in steps 2 / 10 / 11.

---

## What this walkthrough proves

| Spec item | Step that proves it |
| --------- | ------------------- |
| FR-001 (push collects skills for all agents) | 3 + 10 |
| FR-002 (SKILL.md sentinel) | 3 (epsilon disqualification) |
| FR-003 (atomic single-unit archive) | 4 (alpha and beta restored intact on machine B) |
| FR-004 (per-agent vault namespace) | 3 + 10 |
| FR-005 (pull restores to canonical local path) | 4 |
| FR-006 (never-sync inside skill aborts) | 5 |
| FR-007 (status surfaces all-agent skills) | 8 |
| FR-008 (doctor checks new dirs) | 9 |
| FR-009 (missing dirs are no-ops) | 1 (no errors when running on a fresh box) |
| FR-010 (Cursor canonical path) | 10 (skills-cursor exclusion) |
| FR-011 (additive default) | 6 |
| FR-012 (explicit vault removal) | 7 |
| FR-013 (pull never deletes local) | 7 (machine B step) |
| FR-016 (two-tier symlink rule) | 3 (delta + beta interior) + 11 (Copilot retrofit) |
| FR-017 (top-level dot-skip) | 3 (.system, .DS_Store) + 10 (Codex .system) |
| SC-001 / SC-002 (round-trip parity) | 4 + 10 |
| SC-006 / SC-007 (additive + explicit removal) | 6 + 7 |
| SC-008 / SC-009 / SC-010 (symlink and dot-entry coverage) | 3 + 7 + 10 + 11 |

If every step passes, the feature is ready for `/speckit.tasks` (or, if already at `/speckit.tasks` time, ready for review).
