# Data Model: Sync Agents' Skills

**Branch**: `20260411-002222-agent-skills-sync`
**Date**: 2026-04-11
**Purpose**: Name the concrete TypeScript types this feature introduces or touches, the invariants each must uphold, and the lifecycle/state transitions that cross the walker → archiver → encryptor → vault → decryptor → apply boundary. "Data model" here is strictly type- and invariant-level — no implementation code.

---

## Entity 1: `Skill` (on-disk, conceptual)

A `Skill` is a filesystem concept, not a TypeScript type. It exists at `<agentSkillsRoot>/<name>/` and is the unit of archival, encryption, and restoration.

### Invariants a directory MUST satisfy to be recognised as a Skill

- `name` MUST NOT begin with `.` (FR-017).
- The entry at `<agentSkillsRoot>/<name>` MUST resolve via `lstat` as a real directory, not a symbolic link (FR-016 outer tier, R4).
- The entry `<agentSkillsRoot>/<name>/SKILL.md` MUST exist AND MUST resolve via `lstat` as a real regular file, not a symbolic link (FR-002 + FR-016 sentinel guard).
- No file or sub-directory path under `<agentSkillsRoot>/<name>/` MAY match any entry in `NEVER_SYNC_PATTERNS` from `src/core/sanitizer.ts` (FR-006). If any does, the Skill exists on disk but is treated as an **abort-the-operation** condition in the push pipeline; see `SkillWalkWarning` below.

### What is archived

The complete directory tree at `<agentSkillsRoot>/<name>/`, **minus** any file or sub-directory whose `lstat` identifies it as a symbolic link (FR-016 inner tier, R2). The archive is a deterministic `tar.gz` produced with `{ gzip: true, cwd: skillDir, portable: true }` so that the same directory tree produces the same bytes for status-hash comparison (R9 caveat).

### Identity and uniqueness

Within one agent's namespace, the `name` (basename of the directory) is the unique key. Across agents, the `(agent, name)` pair is the unique key. The vault reflects this: `<vaultDir>/<agent>/skills/<name>.tar.age` is the only path that can hold the artifact for `(agent, name)`.

---

## Entity 2: `AgentName` (existing, unchanged)

```ts
type AgentName = "cursor" | "claude" | "codex" | "copilot" | "vscode";
```

Defined in `src/agents/registry.ts`. This feature does **not** add a new agent. Skills sync applies to `claude`, `cursor`, `codex`, and `copilot` only — `vscode` does not have a skills concept and its adapter remains untouched. The walker helper will assert at call sites (via TypeScript narrowing) that it only receives a skill-capable agent name; at runtime the agents that don't wire it up simply never call `collectSkillArtifacts`.

---

## Entity 3: `SkillArtifact` (new type alias)

```ts
/**
 * A SnapshotArtifact specialised for skill directories.
 * Structurally identical to SnapshotArtifact — this alias exists only to
 * make call sites self-documenting and to give future work a place to
 * attach skill-specific metadata without a type refactor.
 */
type SkillArtifact = SnapshotArtifact;
```

### Invariants

- `SkillArtifact.vaultPath` MUST match the regex `^(claude|cursor|codex|copilot)/skills/[^/]+\.tar\.age$`. No nested paths, no alternative extensions (FR-004).
- `SkillArtifact.sourcePath` MUST be the absolute path to the real (non-symlink) skill directory on disk.
- `SkillArtifact.plaintext` MUST be the base64 encoding of a deterministic `tar.gz` of the skill tree (minus interior symlinks), consistent with the existing Copilot convention at `src/agents/copilot.ts:95`.
- `SkillArtifact.warnings` MUST NOT contain a `"never-sync inside skill: "` entry — if the walker detected a never-sync violation, it does NOT emit an artifact for that skill at all (R3), so any `SkillArtifact` reaching Phase 2 of push is clean by construction.

### State transitions

```text
[candidate dir on disk]
    ↓  walker passes all five gates (name not ".", lstat real dir, SKILL.md real file, no interior never-sync, tar produced)
[SkillArtifact with plaintext = base64(tar.gz)]
    ↓  performPush Phase 2 encrypts
[encrypted .age text]
    ↓  git write + commit + push
[<vaultDir>/<agent>/skills/<name>.tar.age in vault tree]
    ↓  pull on another machine: git fetch + reconcile
[encrypted .age text on machine B]
    ↓  applyXxxVault decrypts → base64-decodes → extractArchive
[restored real directory at <agentSkillsRoot>/<name>/ on machine B]
```

No reverse transition exists through this feature. The only way a `SkillArtifact` leaves the vault is via `skill remove` (see Entity 6 below), which operates on the encrypted vault file directly and does not round-trip a `SkillArtifact` instance.

---

## Entity 4: `SkillsWalkerResult` (new type)

```ts
/**
 * The shape returned by the shared skills walker. This is intentionally
 * structurally identical to SnapshotResult so call sites can spread the
 * walker's output directly into their own SnapshotResult.
 */
interface SkillsWalkerResult {
  artifacts: SkillArtifact[];
  warnings: string[];
}
```

### Invariants

- `artifacts` contains one entry per **Skill on disk that passed all walker gates**. Symlinked roots, dot-prefixed entries, directories without a real `SKILL.md`, and directories whose interior walk found a never-sync match are all **absent** from `artifacts`.
- `warnings` contains zero or more strings. Walker-produced warnings use the prefix `"never-sync inside skill: "` followed by the absolute path that matched and the pattern it matched. No other prefixes are produced by the walker — dot-skip and symlink-skip are silent (FR-017, R7).
- `artifacts` and `warnings` are independent: a single push can produce both (for example, three valid skills get archived AND one skill is rejected for a never-sync hit; the push will still abort before encrypting the three valid skills because the push gate escalates any walker warning with the never-sync prefix to fatal — R3).

### Relationship to existing types

`SkillsWalkerResult` is assignment-compatible with `SnapshotResult`. Each agent adapter will spread the walker output into its own `SnapshotResult`:

```ts
const walker = await collectSkillArtifacts("claude", AgentPaths.claude.skillsDir);
artifacts.push(...walker.artifacts);
warnings.push(...walker.warnings);
```

No new top-level registry entry is required.

---

## Entity 5: `SkillWalkWarning` (convention, not a type)

A **convention**, not a TypeScript nominal type: any string in `SnapshotResult.warnings` that starts with `"never-sync inside skill: "` is a `SkillWalkWarning`. The push gate at `src/commands/push.ts:80-98` currently matches the prefix `"Redacted literal secret"` to escalate a snapshot warning to a fatal push error. This feature adds a second prefix match:

```ts
if (w.startsWith("Redacted literal secret") || w.startsWith("never-sync inside skill: ")) {
  secretErrors.push(`[${agent.name}] ${w}`);
}
```

(Pseudocode — actual patch lives in Phase 2 tasks.)

### Invariants

- Once a `SkillWalkWarning` lands in `SnapshotResult.warnings`, the corresponding push MUST NOT write any `.age` file for any agent, not just the offending one. This is already how the existing secret gate behaves — the whole push is aborted on any match.
- The warning text MUST name the offending absolute path so the user can `rm` or `git-ignore` the file. Principle I's security-first stance is that ambiguous abort messages are worse than no abort.
- The warning text MUST NOT name the pattern that matched, to avoid exposing a map of "paths AgentSync deliberately avoids" to logs that might be shipped to third-party observability.

---

## Entity 6: `RemovalOutcome` (new type for `skill remove`)

```ts
/**
 * Result shape for the `skill remove <agent> <name>` command.
 * Modelled as a tagged union so the CLI layer can decide exit code +
 * output format without re-parsing a message string.
 */
type RemovalOutcome =
  | { kind: "removed"; agent: AgentName; name: string; vaultPath: string; commitSha: string }
  | { kind: "not-found"; agent: AgentName; name: string; vaultPath: string }
  | { kind: "git-error"; agent: AgentName; name: string; vaultPath: string; error: string };
```

### Invariants

- `kind: "removed"` MUST only be emitted after the commit has landed AND the push has succeeded (or the user passed `--dry-run`, which is the only case where `commitSha` may be the empty string — see contracts/skill-remove-cli.md for whether `--dry-run` is in scope).
- `kind: "not-found"` MUST drive `process.exitCode = 1` and MUST print the vault path it looked for, so the user can verify they typed the right agent and skill name (FR-012).
- `kind: "not-found"` MUST NOT cause any Git operation, file write, or file delete. The vault state is unchanged on this outcome.
- `kind: "git-error"` is reserved for the narrow window between successful `unlink` of the vault file and a failed `git push`. In this state, the vault working tree has a staged deletion that the user can resolve by re-running `skill remove` or `push`. The error string MUST include the `git` exit code or message to help the user debug. FR-013's pull-side guarantee is unaffected because the vault HEAD has not advanced.

### State machine (CLI command → RemovalOutcome)

```text
  [invoke: skill remove <agent> <name>]
              │
              ▼
   [resolve vaultDir + path]
              │
              ▼
   [agent name valid?] ── no ──▶ kind: not-found (or hard error — TBD in contract)
              │
              yes
              ▼
   [<vaultDir>/<agent>/skills/<name>.tar.age exists?]
              │
     no ──────┴───── yes
      │               │
      ▼               ▼
  kind: not-found   [reconcile with remote]
                        │
                        ▼
                   [unlink file]
                        │
                        ▼
                   [commit]
                        │
                        ▼
                   [push to remote]
                        │
             success ──┴── error
                │            │
                ▼            ▼
        kind: removed   kind: git-error
```

No pull-side state transition exists for `RemovalOutcome`. Other machines discover the removal implicitly on their next `pull`, and their local filesystem is not modified (FR-013).

---

## Entity 7: `AgentPaths` (existing type, extended)

```ts
// src/config/paths.ts — extended shape (conceptual; keys added, not changed)
export const AgentPaths = {
  claude: {
    claudeMd: string;
    settingsJson: string;
    commandsDir: string;
    agentsDir: string;
    mcpJson: string;
    credentials: string;
    skillsDir: string;          // NEW — ~/.claude/skills/
  },
  cursor: {
    mcpGlobal: string;
    commandsDir: string;
    settingsJson: string;
    skillsDir: string;          // NEW — ~/.cursor/skills/ (FR-010)
  },
  codex: {
    root: string;
    agentsMd: string;
    configToml: string;
    rulesDir: string;
    authJson: string;
    skillsDir: string;          // NEW — join(CODEX_HOME, "skills")
  },
  copilot: {
    // ... existing including skillsDir
  },
  vscode: {
    // ... no skillsDir; intentionally omitted
  },
};
```

### Invariants

- Every newly added `skillsDir` is an absolute path. `HOME` and `CODEX_HOME` are resolved at module-load time, same as the existing entries.
- No conditional / platform-branched values on the new entries — skills roots are POSIX-shaped under `$HOME` on all three target platforms.
- The `vscode` entry **MUST NOT** grow a `skillsDir`; adding one would imply this feature covers VS Code, which it does not.

---

## Cross-cutting invariant: vault namespace isolation

For every `(agent, name)` pair, **exactly one** path in the vault is valid:

```text
<vaultDir>/<agent>/skills/<name>.tar.age
```

Where `<agent> ∈ {claude, cursor, codex, copilot}`. This is enforced implicitly by the walker (which hard-codes its own agent into the output path) and explicitly by `skill remove` (which builds the path from the same template).

No code in this feature may write to, read from, or delete files at any other path under `<vaultDir>/<agent>/skills/`. In particular: no `metadata.json`, no `manifest.toml`, no `.tombstone` files. FR-013's pull-side guarantee depends on the vault containing ONLY encrypted skill artifacts and nothing else, because `applyXxxVault` filters to `.age` files and would silently ignore (or worse, crash on) any other shape.

---

## Types this feature **does not** introduce

Explicitly non-goals, listed here so a reviewer can tell at a glance what was deliberately left out:

- No new `Manifest` type listing skills. The vault's ground truth is its directory listing.
- No new `Tombstone` type marking a previously-synced skill as deleted. FR-013 forbids it.
- No per-skill `Metadata` type with author, version, tags, etc. Skills are opaque tarballs.
- No new `NeverSyncPattern` type. `NEVER_SYNC_PATTERNS` in `src/core/sanitizer.ts` stays the single source of truth for excluded paths.
- No new `AgentName` variant. VS Code does not grow skill support.
