# Research: Sync Agents' Skills

**Branch**: `20260411-002222-agent-skills-sync`
**Date**: 2026-04-11
**Purpose**: Resolve every open engineering decision before writing data-model, contracts, and tests. There are no `[NEEDS CLARIFICATION]` markers in the spec (the `/speckit.clarify` session resolved Q1–Q4), so this document instead pins down the *implementation* decisions the plan deliberately deferred: walker placement, tar filter shape, never-sync composition inside the walker, CLI verb placement, and the FR-016 SKILL.md-sentinel `lstat` change.

All decisions below follow the format:

- **Decision** — what we will do
- **Rationale** — why, grounded in the spec and the existing codebase
- **Alternatives considered** — what else we evaluated and why we passed

---

## R1. Where does the shared skills walker live?

**Decision**: Create a new module `src/agents/skills-walker.ts` that exports one async function `collectSkillArtifacts(agent: AgentName, skillsDir: string): Promise<SnapshotResult>`. Import it from the four agent adapters (`claude.ts`, `cursor.ts`, `codex.ts`, `copilot.ts`). Keep `src/agents/_utils.ts` focused on the canonical `SnapshotArtifact` / `SnapshotResult` types and the `readIfExists` / `atomicWrite` / `collect` helpers — do not bloat it.

**Rationale**:

- The walker encodes four distinct rules (FR-002 sentinel, FR-006 never-sync-inside-skill, FR-016 two-tier symlink, FR-017 top-level dot-skip) that together are too big to inline into four agent adapters without copy-paste drift. The spec specifically worries about drift (SC-008 / SC-009 / SC-010 all assume uniform behavior across agents).
- `_utils.ts` already has a single responsibility: shared snapshot types and tiny file helpers. Adding a 100-line walker there muddies that boundary.
- Co-locating the walker under `src/agents/` (rather than `src/core/`) signals that it's an agent-adapter concern and not a reusable crypto/tar primitive. `src/core/` is reserved for things like `encryptor.ts`, `sanitizer.ts`, `tar.ts`, `git.ts` — cross-cutting primitives. The walker is specifically about agent skill directories.

**Alternatives considered**:

- **Put it in `src/agents/_utils.ts`**: rejected — `_utils.ts` is intentionally small and type-only-plus-tiny-helpers; adding the walker there couples unrelated concerns and makes tree-shaking noisier.
- **Put it in `src/core/skills-walker.ts`**: rejected — `src/core/` modules are consumed by multiple layers (commands, daemon, agents). The walker is only ever called from agent adapters, so placing it there invents a boundary that doesn't exist.
- **Inline the rules into each agent**: rejected — four agents means four places to update when a new rule lands; SC-008/009/010 explicitly require identical behavior across agents, which is exactly what a shared helper guarantees cheaply.

---

## R2. How does the walker archive a skill without following symlinks?

**Decision**: Extend `src/core/tar.ts::archiveDirectory` with an optional `skipSymlinks: boolean` parameter (defaulting to `false` so current callers are unchanged). When `true`, install a synchronous `filter` callback on the `tar.create` call that uses `lstatSync` on the absolute resolved path and returns `false` when `stat.isSymbolicLink()` is true. The walker always passes `skipSymlinks: true`.

**Rationale**:

- `tar` v7's `create()` accepts a `filter: (path: string, stat: Stats) => boolean` callback. The `stat` argument provided by tar is from `lstat` internally, so a direct `stat.isSymbolicLink()` check is sufficient — we don't need a second syscall per entry in the common case.
- Having a single option on `archiveDirectory` keeps the API surface tight. The alternative — walking the directory ourselves and feeding tar an explicit file list — would duplicate tar's own directory walk and is slower for large skills.
- The default stays `false` because the existing `archiveDirectory` callers (Copilot agents under `copilot/agents/<name>.tar.age`, per `copilot.ts:104-120`) are about *vendor agent directories*, not skills, and they do not currently need the symlink rule. Keeping the default preserves their behavior bit-for-bit.
- The Copilot *skills* retrofit (plan.md structure section) will switch to the new shared walker and therefore inherit `skipSymlinks: true` automatically, so Copilot skills gain FR-016 compliance without touching `archiveDirectory`'s default.

**Alternatives considered**:

- **Hardcode `skipSymlinks: true` in `archiveDirectory`**: rejected — the Copilot agents use-case and any future non-skill caller would silently lose the ability to archive symlink entries. Not a safe retrofit.
- **Pre-walk the directory with `readdir + lstat` and pass an explicit file list to `tar.create`**: rejected — reimplements tar's own walk, doubles the syscall budget on large skills, and adds a second place where the "is it a symlink?" check can diverge from the walker's outer check.
- **Use tar's `follow: false`**: not an option — `tar` v7's `follow` flag controls whether symlinks are *dereferenced* when reading file contents, not whether they're skipped. With `follow: false` (the default) symlinks are archived as symlink entries, which is exactly what FR-016 forbids.

---

## R3. How does the walker enforce FR-006 (never-sync inside a skill)?

**Decision**: Before calling `archiveDirectory`, the walker performs its own interior `readdir` + `lstat` walk over the (real) skill directory. For every **file** encountered, it runs `shouldNeverSync(absPath)` from `src/core/sanitizer.ts`. On any match, the walker does NOT throw — instead, it records a warning with a dedicated prefix (`never-sync inside skill: `) on the would-be `SnapshotArtifact.warnings` array. The walker still emits the artifact *without* that skill's tar (so `artifacts` does not grow) and appends the warning to the top-level `SnapshotResult.warnings`. The push pipeline's Phase-1 gate (`src/commands/push.ts:80-98`) then matches the new prefix the same way it currently matches `"Redacted literal secret"` and escalates to a fatal error.

**Rationale**:

- The existing push pipeline has exactly one place that decides "this operation must not complete": the secret-literal gate in `performPush` at `push.ts:80-98`. Reusing that gate for never-sync-inside-skill keeps abort logic in one place.
- Returning a warning (rather than throwing) lets the walker continue collecting other real skills so the eventual error message can list *every* offending path in one push, instead of aborting on the first one. Users fixing never-sync violations generally prefer a complete list.
- Using the `shouldNeverSync` glob engine unchanged means `NEVER_SYNC_PATTERNS` remains the single source of truth per Principle I of the constitution. No new never-sync logic is introduced.
- Skipping the tar emission for the offending skill (as opposed to including it and relying on the gate to catch it) is a belt-and-braces defense: even if someone removes the gate later, no never-sync content ever reaches `archiveDirectory` or `encryptString`.

**Alternatives considered**:

- **Throw from the walker on never-sync hit**: rejected — loses the "list every offender" UX, and `snapshotClaude` / `snapshotCursor` / `snapshotCodex` are not currently expected to throw; introducing a new throwing contract is a larger blast radius than needed.
- **Let `archiveDirectory` use a tar filter that rejects never-sync paths**: rejected — moves the rule into `tar.ts` which is a low-level primitive; Principle I wants never-sync decisions made at the sanitization boundary, not inside archival.
- **Add a new global gate inside `performPush` that walks interior skill contents again**: rejected — does the work twice. The walker already has the directory listing open.

---

## R4. How does the walker enforce FR-016's SKILL.md-is-symlink edge case?

**Decision**: The walker uses `lstat` (not `stat`) when checking the `SKILL.md` sentinel. A symlink named `SKILL.md` fails the sentinel check, so the skill is skipped silently — identical to "no sentinel present". This plugs the back door where a vendored skill could otherwise masquerade as user-created by being a real directory whose only skill marker is a symlink into the shared pool.

**Rationale**:

- `stat` follows symlinks and would report "yes, the symlinked `SKILL.md` is a regular file", passing the sentinel check. `lstat` does not follow the link, so `stat.isFile()` is `false` for a symlink entry — failing the sentinel check is automatic.
- The spec edge case "Real skill directory whose SKILL.md sentinel itself is a symlink" explicitly requires skipping, and ties the requirement to FR-016's vendored-pool avoidance intent. No special-case code needed — it falls out naturally if the walker uses `lstat` consistently.
- This fixes a latent issue in the current Copilot implementation at `copilot.ts:12-20` where `fileExists` uses `stat` and `copilot.ts:86-89` checks `skillDirStat?.isDirectory()` from `stat` — a symlink to a directory would pass both. The retrofit in the plan swaps to the new walker and eliminates this silently.

**Alternatives considered**:

- **Keep `stat` and add a second explicit `lstat` call to assert it's not a symlink**: rejected — two syscalls where one suffices, and leaves the "is symlink" check as a bolt-on rather than the natural consequence of using `lstat` throughout.
- **Add a runtime guard that rejects when the resolved target is outside the skills root**: rejected — doable but much more code, and doesn't catch the case of a symlink to another path inside the same skills root.

---

## R5. Where does the `skill remove` CLI verb live?

**Decision**: Create `src/commands/skill.ts` that exports a citty *command group* named `skillCommand` with `remove` as a subcommand (`agentsync skill remove <agent> <name>`). Register the group on the root CLI in `src/cli.ts` alongside `init`, `push`, `pull`, `status`, `doctor`, `daemon`, `key`. Leave room in the group for future verbs (`list`, `info`) without committing to them now — the command file starts with exactly one subcommand.

**Rationale**:

- All existing command modules are single-file per top-level verb (`init.ts`, `push.ts`, `pull.ts`, `status.ts`, `doctor.ts`, `daemon.ts`, `key.ts`, `migrate.ts`). A command group (one file with sub-verbs) is a small new pattern but is cleaner than creating `skill-remove.ts` at the top level, because FR-012's action is genuinely "a verb on skills", not a peer of `push`.
- citty supports command groups via `subCommands: { remove: removeSubCommand }` on a parent `defineCommand` call. The root CLI already uses `subCommands` (see `cli.ts`) so the integration is trivial.
- Putting the group in its own file keeps the CLI surface discoverable: `agentsync skill --help` will list all skill verbs, matching the "one-place-to-look" UX of the rest of the CLI.

**Alternatives considered**:

- **Top-level `agentsync skill-remove <agent> <name>`**: rejected — the dash verb is inconsistent with the rest of the CLI and closes the door on adding `skill list` / `skill info` later without a second name-break.
- **Merge it into `push` as `push --remove <agent>:<name>`**: rejected — violates FR-012's explicit requirement that removal be "distinct from `push`". The whole safety argument of Q2 is that you cannot remove a skill while running a push.
- **Put it under `key` or `doctor`**: rejected — those verbs are about keys and diagnostics, not content lifecycle. Wrong semantic home.

---

## R6. How are new `skillsDir` entries added to `AgentPaths`?

**Decision**: Extend `src/config/paths.ts` by adding a `skillsDir` field to each of the `claude`, `cursor`, `codex` entries. The values are `join(HOME, ".claude", "skills")`, `join(HOME, ".cursor", "skills")`, and `join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "skills")`. The Copilot entry already has `skillsDir` and stays as is. No platform branching is required — skills roots are POSIX-shaped under the user's home on all three platforms.

**Rationale**:

- Constitution Principle III requires path lookups to go through `paths.ts`. These are the only places the walker will read.
- The Codex entry must honor `CODEX_HOME` the same way the existing `agentsMd`, `configToml`, `rulesDir` entries do (`paths.ts:30-36`) — consistency with the existing Codex paths avoids a second source of truth for "where is Codex's home?".
- Cursor's canonical path is locked to `~/.cursor/skills/` by FR-010 of the spec, so the mirror directory `~/.cursor/skills-cursor/` intentionally is not in `paths.ts`. If a future feature wants it, it gets its own path.

**Alternatives considered**:

- **Computed via a helper like `resolveSkillsDir(agent)`**: rejected — one-line `join` calls in a const object are the project's established pattern; indirection through a helper would be the only function of its kind here.

---

## R7. How does the walker mark an "already-symlinked root" skill in the walker result?

**Decision**: Symlinked roots are skipped **silently** — they do not appear in `artifacts`, they do not appear in `warnings`, and they produce no log output. Same for dot-prefixed entries (FR-017). The only thing that reaches `SnapshotResult.warnings` from the walker is a genuine failure condition: never-sync match inside a real skill (R3).

**Rationale**:

- The spec is explicit: FR-016 says "no artifact is written for it, and its link target is never followed or archived" and does not ask for a warning. FR-017 says "silent: no warning, no log, no error". Emitting even a `warn` would violate the letter of the spec.
- A quiet skip also matches the existing Copilot sentinel-skip behavior at `copilot.ts:89` — "not a valid skill directory" silently continues.
- Noise in the push output would train users to ignore warnings, which is the opposite of what the secret-literal and never-sync gates need to work.

**Alternatives considered**:

- **Emit an `info`-level log listing every skipped entry and its reason**: rejected — explicitly forbidden by FR-017's "silently". Can be added later as a `--verbose` flag if users actually ask for it.
- **Return skipped-entry counts in `SnapshotResult`**: rejected — the `SnapshotResult` type is shared across all agents and growing it for one feature's diagnostic is scope creep. Tests can observe skip behavior by asserting `artifacts.length` directly.

---

## R8. How does `skill remove` locate, delete, and propagate?

**Decision**: `skill remove <agent> <name>` resolves the target as `<vaultDir>/<agent>/skills/<name>.tar.age` (using the same path convention as `snapshotCopilot` produces today and the new agents will produce). It:

1. Resolves `runtime.vaultDir` via the existing `resolveRuntimeContext()` helper (same as every other command).
2. Validates `<agent>` is a known `AgentName` (hard-coded list: `claude`, `cursor`, `codex`, `copilot`), exiting with a clear error if not.
3. Checks the target file exists with `stat` / `access`. If not, prints `Skill '<name>' not found in vault for agent '<agent>'` and exits with `process.exitCode = 1`. No Git operation, no commit, no push.
4. On exists: runs `reconcileWithRemote` (same pattern as `performPush`), deletes the file with `unlink`, commits with message `skill remove(<agent>): <name>`, and pushes via `simple-git`.
5. On any Git failure: leaves the vault file deleted (the commit did not land) and prints the Git error. Running the command again will reconcile and succeed.
6. Never touches any local path. `AgentPaths.<agent>.skillsDir` is NOT read by `skill remove` at all.

**Rationale**:

- FR-012 demands: one agent + one name, non-zero on not-found, no local files touched. All four are covered by this flow.
- FR-013 demands: other machines' `pull` must not delete the local skill. This is satisfied implicitly — `applyXxxVault` only iterates `.age` files present in the vault; a file that has been deleted from the vault simply isn't iterated, so `applyXxxSkill` is never called for it, so nothing on the local machine changes. No new pull-side code is required.
- Reusing `resolveRuntimeContext` and the existing `simple-git` `reconcileWithRemote` pattern keeps the new command's error surface identical to `push` and avoids bespoke Git handling that Principle III forbids.

**Alternatives considered**:

- **Have `skill remove` also overwrite the vault file with a tombstone that `pull` then uses to delete locally**: rejected — directly violates FR-013 (pull must not delete local). Also adds a new vault artifact format.
- **Have `skill remove` refuse to run if the vault has uncommitted changes**: rejected — not required by the spec; the `reconcileWithRemote` fast-forward-only rule already covers the interesting safety properties.
- **Have `skill remove` accept `--all` or glob patterns**: rejected — FR-012 explicitly restricts the command to exactly one skill at a time, precisely to avoid the "bad habit → data loss" pattern flagged in the spec's insights.

---

## R9. How does status surface the new skill artifacts without code changes?

**Decision**: No change to `src/commands/status.ts`. The existing implementation at `status.ts:22-42` (`collectAgeFiles`) recursively walks the vault directory and picks up every `.age` file, and at `status.ts:136-154` it compares them against the per-agent snapshot artifact list. When the agent adapters start emitting `claude/skills/<name>.tar.age`-style entries from `snapshot()`, the status pipeline compares them as ordinary artifacts (by plaintext SHA-256) and reports `synced`, `local-changed`, or `vault-only` automatically.

**Rationale**:

- Reuses code that has already been tested and shipped for Copilot skills. Any bug here is a bug in the existing status command, not a new bug introduced by this feature.
- FR-007 requires drift to surface "in the same place and format that Copilot skill drift is already surfaced today" — the best way to guarantee that is to not add a skill-specific code path to status at all.
- The `SnapshotArtifact.plaintext` for a skill is the base64-encoded tar (same pattern as `copilot.ts:95`). Base64 of a stable tar is deterministic for the same directory tree, so the SHA-256 comparison is valid.

**Alternatives considered**:

- **Add a skill-specific status row format that lists interior files**: rejected — adds a new display mode inconsistent with the rest of status, and violates "same place and format" from FR-007.

**Caveat to verify in Phase 2 (tasks)**: tar determinism. `tar.create` with `portable: true` already strips variable metadata like UID/GID, but mtime of individual files can still vary depending on when the directory was last touched. The existing Copilot skill hashing has not been observed to flap in practice, so the assumption is that the plaintext hash is stable enough for status — but the task breakdown must include a test that archives the same directory twice and asserts byte equality of the resulting base64. If that test fails, the fix is to add `mtime: new Date(0)` or similar to the `tar.create` options, which is a localized change in `src/core/tar.ts`.

---

## R10. Documentation diagrams — what do the two Mermaid diagrams show?

**Decision**: Both diagrams live in `docs/architecture.md` under a new "Skills sync flow" section.

- **Diagram 1 (sync flow)**: Shows the path from `~/.<agent>/skills/<name>/` through the walker's gates (root-symlink skip, dot-skip, SKILL.md sentinel, never-sync interior check, interior-symlink skip) into `archiveDirectory` → `encryptString` → vault `<agent>/skills/<name>.tar.age` → pull → decrypt → `extractArchive` → restored local skill directory. Nodes styled with three classes: `keep` (green, survives all gates), `skip` (amber, filtered by walker), `fail` (red, never-sync abort path).
- **Diagram 2 (vault-removal flow)**: Shows the `skill remove` path from user invocation through reconcile → `unlink` → commit → push → remote vault. Then a parallel branch showing machine B running `pull` and leaving its local skill directory untouched. Three-node class palette: `action` (user request), `vault` (vault-side effect), `local` (local-side no-op).

Both diagrams follow the project's GitHub-compatible Mermaid rules from `~/.claude/CLAUDE.md`: `classDef` pairs with WCAG 2 AA contrast, `<br/>` for line breaks (not `\n`), no parentheses in node labels, inline `:::className` syntax, single `subgraph` per diagram, descriptive node IDs of ≥ 3 characters.

**Rationale**:

- FR-015 requires two diagrams covering these two flows specifically. Splitting them into two instead of one megadiagram keeps each diagram below the "review without reverse-engineering" ceiling Principle V enforces.
- The skill walker has five gates between the user's directory and the vault file. Prose alone obscures the order — a diagram makes the order testable against the code.

**Alternatives considered**:

- **One combined diagram for both flows**: rejected — too many nodes, breaks Mermaid readability on GitHub, violates Principle V's "small enough to review" rule.
- **No diagrams, prose only**: rejected — FR-015 explicitly requires them, and Principle V's criterion ("visual explanation materially improves comprehension") is met here.

---

## Summary of resolved decisions

| # | Decision | Module(s) touched |
| - | -------- | ----------------- |
| R1 | New shared walker at `src/agents/skills-walker.ts` | `src/agents/skills-walker.ts` (new), agent adapters |
| R2 | `archiveDirectory` gains opt-in `skipSymlinks` flag via tar `filter` callback | `src/core/tar.ts` |
| R3 | Walker emits `never-sync inside skill:` warnings; push gate escalates to fatal | `src/agents/skills-walker.ts`, `src/commands/push.ts` |
| R4 | Walker uses `lstat` throughout; symlinked `SKILL.md` fails sentinel naturally | `src/agents/skills-walker.ts` |
| R5 | New `skill` command group in `src/commands/skill.ts` with `remove` subverb | `src/commands/skill.ts` (new), `src/cli.ts` |
| R6 | `paths.ts` gains `skillsDir` fields on claude/cursor/codex entries | `src/config/paths.ts` |
| R7 | Symlinked roots and dot-entries skipped silently — no warnings, no logs | `src/agents/skills-walker.ts` |
| R8 | `skill remove` resolves `<vaultDir>/<agent>/skills/<name>.tar.age`, git-deletes, never touches local | `src/commands/skill.ts` |
| R9 | Status command unchanged; existing `collectAgeFiles` picks up new artifacts automatically | (verify with a tar-determinism regression test) |
| R10 | Two Mermaid diagrams in `docs/architecture.md` (sync flow + vault-removal flow) | `docs/architecture.md` |

No `NEEDS CLARIFICATION` remains. Ready for Phase 1.
