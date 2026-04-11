# Feature Specification: Sync Agents' Skills

**Feature Branch**: `20260411-002222-agent-skills-sync`
**Created**: 2026-04-11
**Status**: Draft
**Input**: User description: "sync agents' skills"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Claude skills follow me to a new laptop (Priority: P1)

A developer has built up a library of Claude skills under `~/.claude/skills/` on their primary workstation. They buy a new laptop, install AgentSync, run `pull` against their existing vault, and every skill they authored appears in the same place on the new machine — ready to use in the next Claude session.

**Why this priority**: Claude is the primary daily driver for most AgentSync users, and skills are the richest per-user configuration Claude exposes. Today this is the biggest silent gap in AgentSync's "one encrypted source of truth" promise: CLAUDE.md, commands, and sub-agents sync, but a user's skills vanish on a fresh machine. Closing this gap is the single highest-value piece of the feature.

**Independent Test**: Populate `~/.claude/skills/my-skill/SKILL.md` on machine A, run `push`, initialize a fresh vault checkout on machine B, run `pull`, and confirm the same skill tree exists at `~/.claude/skills/my-skill/` on machine B with identical contents.

**Acceptance Scenarios**:

1. **Given** a Claude skill directory exists at `~/.claude/skills/<name>/` containing a `SKILL.md` file, **When** the user runs `push`, **Then** an encrypted artifact for that skill appears under `claude/skills/` in the vault and the operation reports one Claude skill included.
2. **Given** the vault contains a Claude skill artifact the local machine does not have, **When** the user runs `pull`, **Then** the skill directory is restored under `~/.claude/skills/<name>/` with every file from the original snapshot.
3. **Given** a directory under `~/.claude/skills/` that has no `SKILL.md` sentinel, **When** the user runs `push`, **Then** that directory is skipped with no warning and no artifact is written to the vault.
4. **Given** a Claude skill was updated on another machine, **When** the user runs `status`, **Then** the drift is surfaced alongside the existing Claude artifacts (CLAUDE.md, commands, sub-agents) instead of being invisible.
5. **Given** the entry `~/.claude/skills/<name>` is a symlink that points into a shared pool (for example `/srv/.../shared/skills/<name>`), **When** the user runs `push`, **Then** no artifact is written to `claude/skills/` for that name and the symlink target is neither read nor followed.
6. **Given** a real directory at `~/.claude/skills/<name>` with a valid `SKILL.md` sentinel plus one symlinked helper file inside, **When** the user runs `push` and a second machine runs `pull`, **Then** the skill is restored on the second machine with every real file intact and the symlinked helper omitted.

---

### User Story 2 - Codex skills sync alongside Codex configuration (Priority: P2)

A developer uses Codex as a secondary agent and keeps per-task skills under `~/.codex/skills/`. When they push their AgentSync vault, those skills travel with Codex's `AGENTS.md`, `config.toml`, and rules — they do not have to manually copy directories to reach parity on a second machine.

**Why this priority**: Codex is already a fully supported agent in AgentSync (snapshot, apply, status, and never-sync are wired up), so leaving its skills behind is the same gap as Claude's — only for a smaller user slice. Once the Claude pattern is validated, applying the same shape to Codex is a direct extension with no new domain modelling, which is why it is P2 rather than P1.

**Independent Test**: Place a valid skill under `~/.codex/skills/<name>/SKILL.md` on machine A, push, pull on machine B, and verify the skill directory contents match bit-for-bit.

**Acceptance Scenarios**:

1. **Given** a Codex skill directory with a `SKILL.md` sentinel, **When** the user runs `push`, **Then** an encrypted artifact for that skill is written under `codex/skills/` in the vault.
2. **Given** the vault contains a Codex skill artifact the local machine lacks, **When** the user runs `pull`, **Then** the skill directory is restored under `~/.codex/skills/<name>/`.
3. **Given** a Codex skill directory contains a file whose path matches an existing never-sync pattern, **When** the user runs `push`, **Then** the push aborts with the same guidance AgentSync already gives for other never-sync violations, rather than silently bundling the sensitive file into the archive.

---

### User Story 3 - Cursor skills round-trip without hand-copying (Priority: P3)

A developer who uses Cursor relies on a set of skills stored under `~/.cursor/skills/`. After pointing a second machine at the same AgentSync vault, those Cursor skills are present on the second machine after `pull`.

**Why this priority**: Cursor's skills layout is not yet wired up in AgentSync at all (only commands, MCP, and settings are), so this is new agent surface rather than an extension of an existing pattern. It is ranked P3 because Cursor skills are the least common artifact among current AgentSync users, and the feature should ship the higher-certainty Claude and Codex slices first before extending to Cursor.

**Independent Test**: Create `~/.cursor/skills/<name>/SKILL.md` on machine A, run `push` on machine A, run `pull` on machine B, and verify the skill directory is restored at `~/.cursor/skills/<name>/` with identical contents.

**Acceptance Scenarios**:

1. **Given** a Cursor skill directory with a `SKILL.md` sentinel at `~/.cursor/skills/<name>/`, **When** the user runs `push`, **Then** an encrypted artifact is written under `cursor/skills/` in the vault.
2. **Given** the vault contains a Cursor skill artifact, **When** the user runs `pull`, **Then** the skill directory is restored at `~/.cursor/skills/<name>/`.
3. **Given** a directory exists at `~/.cursor/skills-cursor/` with skill-like contents, **When** the user runs `push`, **Then** nothing from `skills-cursor/` is snapshotted — this feature intentionally scopes Cursor skills to `~/.cursor/skills/` only.

---

### Edge Cases

- **No skills directory at all**: The agent's home (e.g. `~/.codex/skills/`) does not exist yet. Push must succeed without error and simply skip that agent's skill contribution, matching existing AgentSync behavior for missing optional directories.
- **Empty skills directory**: The directory exists but contains no entries. Push must succeed and write zero skill artifacts.
- **Directory without `SKILL.md` sentinel**: A sub-directory under `skills/` does not contain `SKILL.md`. It must be skipped with no artifact and no warning, matching the existing Copilot rule.
- **Never-sync path match inside a skill directory**: A file path inside a skill matches a hard never-sync pattern. Push must abort before the skill is encrypted so the sensitive file never reaches the vault, matching AgentSync's existing never-sync guarantee.
- **Vendored skill symlinked at the skills root**: The entry `~/.claude/skills/<name>` (or the Cursor / Codex equivalent) is itself a symlink into a shared pool (for example `/srv/…/shared/skills/<name>`). FR-016 requires that the walker skip this entry entirely — it is neither followed nor archived, and no artifact is written to the vault for that name. On pull, the local machine is not forced to recreate a symlink — only real user-created skills round-trip.
- **Real skill directory containing a symlinked helper file**: The skill root at `~/.claude/skills/<name>` is a real directory, but a single file inside it (for example `references/shared-template.md`) is a symlink. FR-016 requires the walker to archive the rest of the skill while omitting the symlinked file. Pull on another machine restores the skill without the symlinked helper, and the skill may therefore behave differently on the restored machine if it depended on that helper — this is an accepted tradeoff of the partial-archive rule, documented so users are not surprised.
- **Real skill directory whose SKILL.md sentinel itself is a symlink**: The skill root is a real directory but `SKILL.md` is a symlink. FR-002's sentinel check MUST be symlink-aware: a symlinked `SKILL.md` does NOT satisfy the sentinel requirement, so the skill is treated as "no sentinel" and skipped with no artifact, matching the vendored-pool avoidance intent of FR-016.
- **Dot-prefixed entry directly under a skills root**: The agent's skills root contains an entry whose name begins with `.` (for example `~/.codex/skills/.system/`, or a stray `~/.claude/skills/.DS_Store`). FR-017 requires the walker to skip the entry entirely and silently — no artifact, no warning, no sentinel check. This applies whether the entry is a file, a real directory, or a symlink; no further inspection is performed.
- **Dot-prefixed file nested deep inside a real user skill**: The skill root at `~/.claude/skills/my-skill/` is a real user-created directory that happens to contain a `references/.DS_Store` file deep inside. FR-017 applies only at the top level of the skills root, so this nested dot-file is NOT automatically skipped by FR-017; it is archived along with the rest of the skill unless FR-016 (symlink rule) or the never-sync engine drops it first. The feature does not try to cleanse interior macOS or tool metadata — that is the user's responsibility within their own skill directory.
- **Locally deleted skill**: A skill that existed in a prior push has been deleted locally. By default `push` is additive and never removes the artifact from the vault, so other machines keep receiving the skill on `pull` until the user explicitly removes it from the vault (FR-012). This means an accidental local `rm -rf` can never silently erase skills across machines.
- **Explicit vault removal of a skill that other machines still have locally**: A user has explicitly removed a skill from the vault (FR-012). On any other machine whose local skills directory still contains that skill, `pull` MUST leave the local copy in place — removing from the vault does not imply auto-deleting machines that already had the skill.
- **Explicit vault removal of a skill that is not in the vault**: The user asks to remove a skill that is not currently stored in the vault for the requested agent. The operation MUST exit with a clear "not found" message and a non-zero status, rather than silently succeeding, so the user can notice typos in agent or skill names.
- **Large skill directory**: A skill directory is unusually large (for example hundreds of megabytes). Behavior should match any other large artifact AgentSync already snapshots — the feature introduces no new size ceiling and no new chunking strategy.
- **Collision with Copilot's existing `copilot/skills/` path**: The vault already contains `copilot/skills/<name>.tar.age`. The new agent namespaces (`claude/skills/`, `codex/skills/`, `cursor/skills/`) must not interfere with or overwrite the Copilot path.
- **Apply side, existing local skill with same name**: A skill with the same name already exists on the target machine under the local skills path. The apply path must replace it with the vault version, consistent with how AgentSync already treats other synced artifacts.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The push workflow MUST collect skill directories for each supported agent (Claude, Codex, and Cursor) in addition to the existing Copilot skill collection, so a single `push` run snapshots skills from every agent that has any.
- **FR-002**: A directory under an agent's skills root MUST be treated as a skill only when it contains a real (non-symlink) `SKILL.md` sentinel file. The push pipeline MUST NOT archive a directory that lacks this sentinel; pull restores whatever the walker previously archived, so the sentinel rule is enforced **once at archival time** and inherited by every subsequent pull. Directories without a real `SKILL.md` therefore never enter the vault and never reach a destination machine through this feature.
- **FR-003**: Each collected skill MUST be archived as a single unit before encryption, so that the full skill tree (SKILL.md plus any supporting files and sub-directories) is restored atomically on apply.
- **FR-004**: Encrypted skill artifacts for each agent MUST live under an agent-specific vault namespace (`claude/skills/`, `codex/skills/`, `cursor/skills/`) that is distinct from the existing `copilot/skills/` path, so that two agents can each have a skill named `my-skill` without collision.
- **FR-005**: The pull workflow MUST restore each encrypted skill artifact to the canonical local skills directory for its agent, creating any missing parent directories, so that a fresh machine gets an identical layout to the source machine.
- **FR-006**: Any file path inside a candidate skill directory that matches AgentSync's existing never-sync rules MUST cause the push to abort before the skill is encrypted, using the same error surface as other never-sync violations.
- **FR-007**: The status command MUST surface drift for skills of every supported agent, not only Copilot, so that a user can tell from `status` alone whether their skill tree is in sync.
- **FR-008**: The doctor command MUST include each newly supported skills directory in its existence and readability checks so that a misconfigured local environment is reported in the same place as other agent paths.
- **FR-009**: Missing skills directories (for example, `~/.codex/skills/` not existing on a machine that never uses Codex) MUST be treated as "no skills contributed" and MUST NOT cause push, pull, status, or doctor to fail.
- **FR-010**: The canonical Cursor skills source path that AgentSync snapshots and restores MUST be `~/.cursor/skills/`. Any other plausible Cursor directory (for example `~/.cursor/skills-cursor/`) MUST NOT be read or written by this feature.
- **FR-011**: The default push workflow MUST be additive with respect to skills. Deleting a skill directory locally and then running `push` MUST NOT remove the corresponding artifact from the vault, so an accidental local `rm -rf` can never silently erase skills across the user's other machines.
- **FR-012**: Users MUST be able to explicitly remove a named skill artifact from the vault for a named agent, as a deliberate action that is distinct from `push`. The operation MUST target exactly one skill at a time, MUST NOT touch the local skills directory on the machine that initiates it, MUST report "not found" with a non-zero status when the requested skill is not present in the vault for that agent, and MUST leave skill artifacts for other agents and other skill names untouched.
- **FR-013**: When an explicit vault removal (FR-012) has taken effect and another machine runs `pull`, the pull MUST NOT delete the corresponding local skill directory on that other machine. Pull-side behavior for vault removals is "do not propagate the deletion locally", preserving the safety guarantee that AgentSync never deletes local skill files as a side-effect of someone else's action.
- **FR-014**: The feature MUST document the new vault namespaces, the `SKILL.md`-sentinel rule, the default-additive push semantics (FR-011), and the explicit vault-removal action (FR-012, FR-013) in the command reference and architecture guide, so a reader of `docs/` can tell what ends up in the vault and how to take things out of it without reading source.
- **FR-015**: The architecture guide MUST include a Mermaid diagram showing the end-to-end skill flow (local skills directory → sentinel check → tar archive → age encryption → vault namespace → pull → atomic restore) for the newly supported agents, and a second Mermaid diagram showing the vault-removal action (explicit user request → vault namespace entry removed → next pull on another machine leaves the local skill in place), so reviewers can validate both data paths without walking code.
- **FR-016**: The skill collection walker MUST apply a two-tier symlink rule. First, when iterating the entries directly under an agent's skills root, any entry whose root is a symlink (regardless of where it points) MUST be skipped entirely — no artifact is written for it, and its link target is never followed or archived. Second, when walking a real (non-symlink) skill directory, any individual file or sub-directory inside it that is a symlink MUST be omitted from the archive while the surrounding real content is still archived. The net effect: vendored skills that users have symlinked into their local skills root from a shared pool never reach the vault, and real user-created skills still sync even when they reference a helper file via a symlink — minus that specific link entry.
- **FR-017**: When iterating the entries directly under an agent's skills root, the walker MUST skip any entry whose name begins with `.` (a leading dot), regardless of whether that entry is a file, a real directory, or a symlink. Skipping is silent: no warning, no log, no error, and no artifact written. This rule is applied at the top level of the skills root only, so a dot-entry nested deep inside a real user skill is not affected by this rule — only the interior-symlink rule from FR-016 applies there. The net effect: vendor-shipped directories like `~/.codex/skills/.system/`, macOS metadata files like `.DS_Store`, tool-managed manifests like `.cursor-managed-skills-manifest.json`, and any stray `.git/` someone version-controls into a skills root are all excluded from the vault without having to be named individually.

### Key Entities *(include if feature involves data)*

- **Skill**: A self-contained, per-agent bundle of instructions and supporting files, identified by its directory name and validated by the presence of a `SKILL.md` sentinel file. Every other file inside the directory is considered part of the skill and must round-trip.
- **Agent skills root**: The per-agent parent directory under which individual skill directories live (`~/.claude/skills/`, `~/.codex/skills/`, `~/.cursor/skills/`, and the already-wired `~/.copilot/skills/`). This is the only place AgentSync looks for skills for that agent.
- **Vault skill namespace**: The per-agent path inside the encrypted vault where skill artifacts are written (`claude/skills/`, `codex/skills/`, `cursor/skills/`, alongside the existing `copilot/skills/`). Each namespace is independent so that two agents can host a skill with the same name.
- **Skill artifact**: One encrypted, archived file in the vault that represents exactly one skill for exactly one agent. Restoring this artifact on another machine recreates the full skill directory for that agent.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After running `push` on machine A and `pull` on machine B against the same vault, every skill that had a `SKILL.md` sentinel on machine A — across Claude, Codex, Cursor, and the already-supported Copilot — is present on machine B with identical file contents and identical directory layout.
- **SC-002**: A user setting up a new laptop can reach full skill parity with their primary machine by running only `init` and `pull` — with zero manual file copying, zero scp/rsync, and zero editing of any skill file by hand.
- **SC-003**: Running `status` on a machine whose skills have drifted from the vault surfaces that drift for Claude, Codex, and Cursor skills in the same place and format that Copilot skill drift is already surfaced today.
- **SC-004**: A `push` that encounters a never-sync file path inside any agent's skill directory aborts before any skill artifact is written to the vault, and the abort message points the user to the offending path. No encrypted skill artifact containing a never-sync file is ever created.
- **SC-005**: Running `push` or `pull` on a machine that has no skills directory for one or more agents succeeds with exit code 0, contributes zero skill artifacts for those agents, and does not log a warning about the missing directory.
- **SC-006**: Deleting a skill directory locally and then running `push` leaves the vault artifact for that skill unchanged, and a subsequent `pull` on the same machine restores the deleted skill from the vault — proving the additive-by-default guarantee of FR-011.
- **SC-007**: After the user explicitly removes a named skill from the vault (FR-012), the next `push` from any machine does not re-introduce it, the next `pull` on any machine that did not have the skill locally does not restore it, and the next `pull` on any machine that still has the skill locally leaves the local copy in place — proving FR-013.
- **SC-008**: Given a skills root that contains a mix of real user-created skill directories and top-level symlinked entries pointing into a shared pool, `push` produces zero vault artifacts for any symlinked entry and one artifact for each real skill — proving the root-level half of FR-016. Given a real skill whose interior contains a symlinked helper file, the resulting vault artifact unpacks on pull to a directory that contains every real file from the source and zero symlink entries — proving the interior half of FR-016.
- **SC-009**: After a successful push from a machine whose skills root contains symlinked vendored entries, inspecting the encrypted vault artifacts for that agent reveals no file, path, or content originating from the symlink target tree — confirming that vendored pools are never leaked into the vault even indirectly through tar-follow or path traversal.
- **SC-010**: Given a skills root that contains any combination of a real user skill, a top-level dot-prefixed directory (for example `.system/`), a top-level dot-prefixed file (for example `.DS_Store`), and a top-level dot-prefixed symlink, `push` produces exactly one vault artifact — the one for the real user skill — and zero artifacts for any dot-prefixed entry, confirming FR-017's top-level dot-skip rule across all three entry kinds.

## Assumptions

- Copilot, Claude, Codex, and Cursor are already supported agents in AgentSync; this feature extends the existing snapshot and apply architecture rather than introducing new agents.
- The Copilot skills pipeline in `src/agents/copilot.ts` is the reference implementation: its `SKILL.md` sentinel rule, tar-then-encrypt shape, and `<agent>/skills/<name>.tar.age` vault path are the pattern the other agents will follow.
- Default push for skills is strictly additive (FR-011), and the only way a skill leaves the vault is the explicit vault-removal action introduced in FR-012. There is no implicit "mirror deletes on push" mode anywhere in this feature.
- Never-sync pattern matching already runs on absolute source paths; applying it to skill directory contents is a matter of walking the directory before archival, not a new matching engine.
- The existing fast-forward-only reconciliation rule across init, pull, push, key, and daemon already covers the new skill artifacts because they live inside the same vault repository — no new conflict model is needed.
- The explicit vault-removal action (FR-012) is authoritative only for the vault: it deliberately never touches local skill directories on any machine, including the machine that initiates it, so users can safely remove stale skills from the vault without worrying about losing their local working copy.
- Symlinked top-level skill entries are assumed to be vendored content sourced from a shared pool outside the user's personal configuration (confirmed on the reference machine: `~/.claude/skills/migrate-jest-to-vitest` and siblings link into `/srv/.../luxgroup/skills/skills/...`). The feature's intent is to sync only skills the user created locally, so FR-016 treats "root entry is a symlink" as "not a user-created skill" and skips it unconditionally.
- Dot-prefixed top-level entries under a skills root are assumed to be vendor-, tool-, or OS-managed metadata that the user did not hand-author as a skill (confirmed on the reference machine: `~/.codex/skills/.system/` is a Codex-shipped bundle). FR-017 skips them without attempting to distinguish "vendored" from "user-created" by any means beyond the leading-dot naming convention, which is the universal Unix signal for hidden/system content.
- This feature is not documentation-only under the constitution: it ships runtime source code changes across several agent adapters, so it requires automated tests for both the happy path and at least one error path (the canonical error case is a never-sync violation inside a skill directory; a second required error case is FR-012's "skill not found in vault" branch).

## Clarifications

### Session 2026-04-11

- Q: When should a symlink cause AgentSync to skip a skill? → A: Skip the whole skill when the skill root is itself a symlink; inside a real skill root, omit individual symlink files and sub-directories from the archive but still sync the surrounding real content (Option B — partial archive allowed for real skills). FR-016 encodes the rule; edge cases "Vendored skill symlinked at the skills root", "Real skill directory containing a symlinked helper file", and "Real skill directory whose SKILL.md sentinel itself is a symlink" make the rule testable; SC-008 and SC-009 make it measurable.
- Q: How should AgentSync handle hidden / dot-prefixed entries directly under an agent's skills root (for example `~/.codex/skills/.system/` or a stray `.DS_Store`)? → A: Skip any entry whose name begins with `.` at the top level of the skills root, silently and without warning, regardless of whether it is a file, a real directory, or a symlink (Option A — unconditional top-level dot-skip). FR-017 encodes the rule; edge cases "Dot-prefixed entry directly under a skills root" and "Dot-prefixed file nested deep inside a real user skill" delimit its scope; SC-010 proves it.

#### Question 1: Cursor canonical skills path — RESOLVED

**Question**: Which Cursor directory is the canonical "Cursor skills" source that AgentSync should snapshot for User Story 3, given the host filesystem shows both `~/.cursor/skills/` and `~/.cursor/skills-cursor/` with different contents?

**Answer**: Option A — `~/.cursor/skills/` only.

**Impact on the spec**:

- User Story 3 is now scoped to exactly `~/.cursor/skills/`; its acceptance scenarios name that path concretely instead of referring to a "canonical path".
- FR-010 locks in `~/.cursor/skills/` as the only Cursor skills source. `~/.cursor/skills-cursor/` is explicitly not read or written by this feature.
- User Story 3 has a new acceptance scenario asserting that `~/.cursor/skills-cursor/` content is ignored, so a future reviewer cannot mistake the omission for a bug.

#### Question 2: Deletion semantics for removed skills — RESOLVED

**Question**: When a user deletes a skill locally and then pushes, what should happen on another machine's next pull?

**Answer**: Option A with an explicit escape hatch — default push is strictly additive (a local delete never affects the vault), AND there is a separate, deliberate action the user can take to remove a skill from the vault when they truly want it gone. The removal action is distinct from `push` so that a stray `rm -rf` on any machine can never silently propagate to other machines.

**Impact on the spec**:

- FR-011 locks in strict additive-by-default push for skills.
- FR-012 introduces the explicit vault-removal action: targets one agent + skill name at a time, leaves local files alone on every machine, and reports "not found" with non-zero status when the requested skill is not in the vault.
- FR-013 specifies pull-side behavior when an explicit removal has taken effect: other machines that still have the skill locally keep their copy, so no local file is ever deleted as a side-effect of someone else's action.
- Two new edge cases ("Explicit vault removal of a skill that other machines still have locally", "Explicit vault removal of a skill that is not in the vault") make the removal semantics testable.
- SC-006 proves additive-by-default (local delete + push + pull restores the skill).
- SC-007 proves that explicit vault removal propagates "nothing is in the vault anymore" without ever deleting a local file.
- Assumptions now explicitly state that there is no implicit "mirror deletes on push" mode anywhere in this feature, so planners cannot re-introduce one by accident.

## Documentation Impact

This feature is a runtime source-code change across several agent adapters, so it does not qualify for the documentation-only testing exception. It still carries concrete documentation updates that reviewers must validate:

- **docs/command-reference.md**: Update the `push`, `pull`, `status`, and `doctor` entries so the reader can see that skills now round-trip for Claude, Codex, and Cursor (not only Copilot). Name the new vault namespaces (`claude/skills/`, `codex/skills/`, `cursor/skills/`). Document the new explicit vault-removal action introduced in FR-012, including: that it targets exactly one agent + skill name, that it never touches any local skill directory, and that it exits non-zero with "not found" when the requested skill is not in the vault.
- **docs/architecture.md**: Update the module map and sync flow sections so skills are no longer a Copilot-only branch. Add the two Mermaid diagrams required by FR-015: (1) the end-to-end sync flow (local skills directory → `SKILL.md` sentinel check → tar archive → age encryption → per-agent vault namespace → pull → atomic restore) and (2) the vault-removal flow (explicit user request → vault namespace entry removed → next pull on another machine leaves the local skill in place). Both diagrams must follow the GitHub-compatible Mermaid rules in the project conventions (inline `:::className` styles, single `subgraph`, `<br/>` instead of `\n`, no parentheses in node labels, high-contrast WCAG AA class definitions).
- **docs/troubleshooting.md**: Add six new entries: (1) "my skills did not push" → point at the `SKILL.md` sentinel rule and FR-002; (2) "my push aborted because of a never-sync file inside a skill" → point at FR-006 and the existing never-sync guidance; (3) "I deleted a skill locally and it came back after pull" → point at the additive-by-default guarantee in FR-011 and direct the reader to the explicit vault-removal action; (4) "I removed a skill from the vault but it is still on my other laptop" → point at FR-013 (pull never deletes local skill files as a side-effect of someone else's removal); (5) "my vendored / symlinked skill did not sync" → point at FR-016's root-symlink skip rule and explain that this is intentional (only real, user-created skills round-trip); (6) "a helper file inside my skill is missing on the other machine after pull" → point at FR-016's interior-symlink omission rule and the `Real skill directory containing a symlinked helper file` edge case.
- **Manual walkthrough reviewers must validate** (because automated tests cannot cover the cross-machine round trip): push on machine A with at least one skill per supported agent, pull on machine B with an empty local skills directory for each agent, diff the restored trees against the originals, confirm `status` reports clean afterwards, then exercise the FR-012 removal action and confirm FR-013's "do not delete local" guarantee on machine B. Record this walkthrough in the feature's plan or quickstart artifact.
- **README.md**: If the "What a vault means here" section still cites only `copilot/skills/<name>.tar.age` as the skill example, extend it to name the new namespaces so the top-of-repo description does not silently lie about coverage. Add a one-line note that AgentSync never silently deletes vault skills: removal is always an explicit user action.
