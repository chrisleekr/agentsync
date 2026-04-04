# Feature Specification: Initial Function Testing

**Feature Branch**: `001-initial-function-testing`
**Created**: 2026-04-04
**Status**: Draft
**Input**: User description: "This is new application that never been tested. I want to go through each function and it is functioning as expected."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Core Security Functions Are Verified (Priority: P1)

As a developer integrating agent-sync, I need confidence that all encryption and secret-redaction functions behave correctly so that sensitive credentials are never leaked in plain text.

**Why this priority**: The entire system's trust model depends on encryption and redaction being correct. A bug here is a security failure, not a functional regression. This must be verified before any other module.

**Independent Test**: Can be fully tested by running the core encryption and sanitizer module tests in isolation — no git remote, no real agent config files, no daemon needed. Delivers the critical security baseline.

**Acceptance Scenarios**:

1. **Given** a plaintext string and a valid age recipient public key, **When** `encryptString` is called, **Then** the returned ciphertext is ASCII-armored text that cannot be read as the original string.
2. **Given** ASCII-armored ciphertext and the matching age private key, **When** `decryptString` is called, **Then** the returned value exactly matches the original plaintext.
3. **Given** a newly generated identity via `generateIdentity`, **When** `identityToRecipient` is called with that identity, **Then** a valid `age1…` public key is returned.
4. **Given** a file on disk and a recipient list, **When** `encryptFile` is called, **Then** an armored output file is written and the original file content is not readable in the output.
5. **Given** an encrypted file and the correct private key, **When** `decryptFile` is called, **Then** the output file matches the original source content byte-for-byte.
6. **Given** a JSON object with a value matching an OpenAI API key pattern (`sk-…`), **When** `redactSecretLiterals` is called, **Then** the value is replaced with `$AGENTSYNC_REDACTED_<FIELD>` and a warning is returned.
7. **Given** a path string matching any entry in `NEVER_SYNC_PATTERNS` (e.g., `auth.json`, `history.jsonl`), **When** `shouldNeverSync` is called, **Then** it returns `true`.
8. **Given** a path that does not match `NEVER_SYNC_PATTERNS`, **When** `shouldNeverSync` is called, **Then** it returns `false`.
9. **Given** a raw `settings.json` string with both `hooks` and unrelated keys, **When** `sanitizeClaudeHooks` is called, **Then** only the `hooks` subtree is returned with any secret values redacted.
10. **Given** a raw `~/.claude.json` string containing `mcpServers` with embedded API keys, **When** `sanitizeClaudeMcp` is called, **Then** only `mcpServers` is returned with secret values replaced by redaction placeholders.

---

### User Story 2 - Archive Functions Preserve Directory Integrity (Priority: P2)

As a developer using agent-sync to sync skill and agent directories, I need the archive and extraction functions to faithfully round-trip directory contents without data loss or security vulnerabilities.

**Why this priority**: The Copilot agent uses tarballs as its sync unit. If archiving or extraction is broken, syncing entire skill or agent directories silently fails or corrupts user files.

**Independent Test**: Can be fully tested by creating a temporary directory with nested files, archiving it, extracting to a new directory, and comparing contents. No encryption, git, or network access required.

**Acceptance Scenarios**:

1. **Given** a directory containing nested subdirectories and files, **When** `archiveDirectory` is called, **Then** it returns a non-empty Buffer representing a valid gzipped tar archive.
2. **Given** that Buffer and an empty target directory, **When** `extractArchive` is called, **Then** all original files and directory structure are reproduced exactly.
3. **Given** an archive entry with an absolute path (e.g., `/etc/passwd`), **When** `extractArchive` is called, **Then** the entry is skipped and no file is written outside the target directory.
4. **Given** an archive entry containing a path traversal segment (`../secret`), **When** `extractArchive` is called, **Then** the entry is skipped and no file is written outside the target directory.

---

### User Story 3 - Configuration Loads and Validates Correctly (Priority: P3)

As a developer setting up agent-sync on a new machine, I need the configuration system to reliably read, validate, and persist settings so that misconfiguration fails fast with a clear error.

**Why this priority**: All commands depend on a valid loaded config. Silent acceptance of invalid data causes every downstream operation to behave unpredictably.

**Independent Test**: Can be fully tested using temporary config files with valid and invalid TOML content, with no network or OS services needed.

**Acceptance Scenarios**:

1. **Given** a valid `agentsync.toml` file, **When** `loadConfig` is called, **Then** a fully typed config object is returned with all expected fields populated.
2. **Given** a TOML file missing a required field (e.g., no `version`), **When** `loadConfig` is called, **Then** an error is thrown describing the validation failure.
3. **Given** a valid config object, **When** `writeConfig` is called, **Then** the file on disk contains well-formed TOML that round-trips back to an equivalent config object via `loadConfig`.
4. **Given** a vault directory path, **When** `resolveConfigPath` is called, **Then** it returns `<vaultDir>/agentsync.toml`.
5. **Given** the current operating system, **When** `resolveAgentSyncHome` is called, **Then** it returns `~/.config/agentsync` on macOS/Linux or `%APPDATA%/agentsync` on Windows.
6. **Given** the current operating system, **When** `resolveDaemonSocketPath` is called, **Then** it returns a path ending in `daemon.sock` on macOS/Linux or a Windows named pipe path on Windows.

---

### User Story 4 - Agent Snapshot Functions Capture the Right Files (Priority: P4)

As a developer running `agent-sync push`, I need each agent's snapshot function to capture exactly the right config files — no more, no less — so that the vault only contains what was intended.

**Why this priority**: Snapshot accuracy controls what gets synced. Capturing too little means config loss; capturing sensitive files outside the intended contract is a privacy risk.

**Independent Test**: Can be fully tested by populating temporary home directory fixtures with known agent config files and asserting the returned snapshot result contains correct vault paths and sanitized content.

**Acceptance Scenarios**:

1. **Given** a `CLAUDE.md` file, a `settings.json` with hooks, and a `~/.claude.json` with `mcpServers`, **When** `snapshotClaude` is called, **Then** artifacts for each file are returned with correct vault paths and sanitized content.
2. **Given** a `AGENTS.md` file, a `config.toml`, and `.md` rule files, **When** `snapshotCodex` is called, **Then** artifacts for all those files are included with correct vault paths.
3. **Given** a VS Code MCP config file containing an embedded API key, **When** `snapshotVsCode` is called, **Then** the artifact content has the API key replaced by a redaction placeholder.
4. **Given** a Copilot skills directory containing nested files, **When** `snapshotCopilot` is called, **Then** the skill artifact contains a base64-encoded gzipped tar of that directory.
5. **Given** `readIfExists` is called with a path to a non-existent file, **Then** it returns `null` without throwing.
6. **Given** `atomicWrite` is called with content and a target path, **When** the write completes, **Then** the file contains the expected content and no `.tmp` sidecar file remains on disk.

---

### User Story 5 - Agent Apply Functions Write Files to the Correct Locations (Priority: P5)

As a developer running `agent-sync pull`, I need each agent's apply function to write decrypted config to the correct path on disk so that local tools immediately pick up the synced settings.

**Why this priority**: A broken apply means users sync successfully to the vault but see no change in their local environment — a silent failure that is hard to diagnose.

**Independent Test**: Can be fully tested using a temporary home directory, pre-seeded vault `.age` files, and a test identity, then asserting files appear at the expected paths.

**Acceptance Scenarios**:

1. **Given** an encrypted `CLAUDE.md.age` in the vault, **When** `applyClaudeVault` is called with the correct key, **Then** the local `CLAUDE.md` is written with the original plaintext content.
2. **Given** an existing `settings.json` with a `theme` key and an incoming hooks vault artifact, **When** `applyClaudeHooks` is called, **Then** the `hooks` key is updated and the `theme` key is preserved.
3. **Given** an encrypted skill archive in the vault, **When** `applyCopilotVault` is called, **Then** the skill directory is extracted to `~/.copilot/skills/<skillName>/` with the correct file structure.
4. **Given** a `dryRun: true` flag, **When** any apply function is called, **Then** no files are written or modified on disk.
5. **Given** an existing Codex `config.toml` with a local-only key and incoming TOML with an overlapping key, **When** `applyCodexConfig` is called, **Then** the incoming key overwrites the match and the local-only key is retained.

---

### User Story 6 - IPC Server and Client Communicate Reliably (Priority: P6)

As a developer using CLI commands that communicate with the daemon, I need the IPC layer to reliably forward requests and return responses so that control commands behave correctly.

**Why this priority**: The daemon's entire control surface is IPC-based. Broken IPC means push, pull, and status commands sent through the daemon silently fail or time out.

**Independent Test**: Can be fully tested by starting an `IpcServer` on a temporary socket path, sending commands via `IpcClient`, and asserting matching responses. No git or encryption required.

**Acceptance Scenarios**:

1. **Given** an `IpcServer` listening on a socket with a registered handler, **When** `IpcClient` sends a matching command, **Then** the client receives a response with `ok: true` and the handler's return value.
2. **Given** a request for a command not registered on the server, **When** the client sends it, **Then** the response has `ok: false` and a descriptive error message.
3. **Given** no daemon listening at the socket path, **When** `IpcClient` attempts to connect, **Then** it rejects with an error within 5 seconds.
4. **Given** a stale socket file from a previous run, **When** `IpcServer.listen` is called, **Then** the stale file is removed and the server starts successfully.

---

### User Story 7 - File Watcher Debounces and Triggers Callbacks Correctly (Priority: P7)

As a developer with the daemon running, I need file changes to trigger an automated push with a debounce window so that rapid saves do not generate excessive git commits.

**Why this priority**: Without correct debounce behaviour, the daemon thrashes the git remote on every keystroke. Verifying the watcher ensures push frequency is controlled.

**Independent Test**: Can be fully tested by creating a temporary file, attaching a `Watcher` callback with a short debounce window, writing rapidly, and asserting the callback fires exactly once.

**Acceptance Scenarios**:

1. **Given** a file watched with a 100ms debounce (test-only override; production daemon MUST use ≥300ms per constitution §III), **When** it is modified 5 times within 50ms, **Then** the callback fires exactly once after the debounce window elapses.
2. **Given** a watched path, **When** `Watcher.remove` is called, **Then** subsequent changes to that path do not trigger the callback.
3. **Given** a `Watcher` with active watchers, **When** `Watcher.close` is called, **Then** all watchers are stopped and no further callbacks are invoked.

---

### User Story 8 - CLI Commands Produce Correct End-to-End Outcomes (Priority: P8)

As an end user of agent-sync, I need the full CLI commands (`init`, `push`, `pull`, `status`, `doctor`, `key`) to behave correctly against a real vault so that I can trust the tool in daily use.

**Why this priority**: This validates the integration of all layers. Passing P1–P7 proves building blocks work; this story verifies they assemble correctly into user-facing commands.

**Independent Test**: Can be tested using a local bare git repository as the remote, a temporary home directory, and a generated age identity. No external services required.

**Acceptance Scenarios**:

1. **Given** a bare git repository URL and no existing vault, **When** `agentsync init --remote <url>` is run, **Then** an age keypair is generated, `agentsync.toml` is written, and the vault is pushed to the remote.
2. **Given** an initialised vault and at least one enabled agent with a local config file, **When** `agentsync push` is run, **Then** an encrypted `.age` file appears in the vault for each config file and a git commit is recorded.
3. **Given** a vault containing at least one `.age` file, **When** `agentsync pull` is run, **Then** the decrypted content is written to the correct local path for the corresponding agent.
4. **Given** vault content that matches local files, **When** `agentsync status` is run, **Then** all files are reported as `synced`.
5. **Given** a local file modified after the last push, **When** `agentsync status` is run, **Then** that file is reported as `local-changed`.
6. **Given** all prerequisite environment checks are satisfied, **When** `agentsync doctor` is run, **Then** all 7 checks pass and are reported with a pass indicator.
7. **Given** an initialised vault, **When** `agentsync key add myteammate <pubkey>` is run, **Then** the new recipient is added to config and all vault `.age` files are re-encrypted for the expanded recipient list.
8. **Given** an initialised vault, **When** `agentsync key rotate` is run, **Then** a new identity is generated, the old key file is overwritten, and all `.age` files are re-encrypted and pushed.
9. **Given** an agent config file whose content contains a value matching a known secret pattern (e.g., `sk-…`), **When** `agentsync push` is run, **Then** the operation aborts with a clear error message, no `.age` file is written to the vault, and no git commit is created (constitution §I).

---

### Edge Cases

- What happens when a config file referenced by a snapshot function does not exist on disk?
- How does the system handle an `.age` vault file that was encrypted for a different recipient than the current private key?
- What happens when the git remote is unreachable during a `push` or `pull`?
- How do apply functions behave when the target directory does not yet exist?
- What happens when `atomicWrite` is called to a path whose parent directory cannot be created due to permissions?
- How does the sanitizer handle a deeply nested object with many keys — is performance acceptable?

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Each exported function in `src/core/encryptor.ts` MUST have automated tests verifying encryption roundtrip correctness and key derivation accuracy.
- **FR-002**: Each exported function in `src/core/sanitizer.ts` MUST be tested with inputs containing known secret patterns and inputs without secrets, verifying correct redaction and correct pass-through respectively.
- **FR-003**: `archiveDirectory` and `extractArchive` MUST be tested for roundtrip fidelity and MUST be shown to reject path traversal and absolute-path entries.
- **FR-004**: `loadConfig` MUST be tested with both valid and structurally invalid TOML; `writeConfig` MUST be shown to round-trip through `loadConfig` without data loss.
- **FR-005**: All agent snapshot functions (`snapshotClaude`, `snapshotCodex`, `snapshotCopilot`, `snapshotCursor`, `snapshotVsCode`) MUST use temporary file fixtures representing realistic agent config files.
- **FR-006**: All agent apply functions MUST be tested by asserting file content at expected output paths after a call with known input; `dryRun` mode MUST be verified to produce no file writes.
- **FR-007**: `IpcServer` and `IpcClient` MUST be tested for successful request-response exchange, unknown-command handling, connection timeout, and stale-socket recovery.
- **FR-008**: `Watcher` MUST be tested for correct debounce behaviour — multiple rapid changes MUST result in exactly one callback invocation after the debounce window.
- **FR-009**: CLI command integration tests MUST use a local bare git repository and temporary home directory, with no dependency on external services or network access.
- **FR-010**: All tests MUST clean up temporary files and sockets after each test case to prevent cross-test contamination.
- **FR-011**: Test coverage MUST be reported. Security-critical modules (`src/core/encryptor.ts`, `src/core/sanitizer.ts`, `src/config/schema.ts`) MUST reach ≥90% line coverage; all other modules MUST reach ≥70% line coverage (constitution §II).
- **FR-012**: The entire test suite MUST be executable without network access, live OS service changes, or access to the CI machine's real agent config files.

### Key Entities

- **Test Fixture**: A temporary directory or file pre-populated with known content, used as test input and cleaned up after each test.
- **Age Identity**: A generated keypair used exclusively within tests — never a real user identity.
- **Vault Directory**: A temporary directory acting as the encrypted config store during testing.
- **Bare Git Repository**: A local `git init --bare` repository used as a network-free remote substitute during CLI integration tests.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: The full test suite completes within 60 seconds on a standard developer machine.
- **SC-002**: Security-critical modules (`encryptor.ts`, `sanitizer.ts`, `config/schema.ts`) achieve ≥90% line coverage; all other modules in `src/` achieve ≥70% line coverage (constitution §II).
- **SC-003**: Zero tests depend on external network access, live OS services, or real user config files — the suite passes on a fresh CI environment with no agent tools installed.
- **SC-004**: Every exported function documented in the codebase has at least one corresponding test case.
- **SC-005**: All encryption roundtrip tests pass consistently across 10 repeated runs with no timing-related flakiness.
- **SC-006**: Path traversal and zip-slip attack scenarios in `extractArchive` are rejected in 100% of test runs.
- **SC-007**: The `dryRun` flag prevents all file system writes in 100% of apply function calls tested with `dryRun: true`.

## Assumptions

- The project uses `bun test` (`bun:test` built-in) as its sole test runner. The existing files `schema.test.ts` and `sanitizer.test.ts` already use `bun:test`; no change to the test framework is in scope.
- Tests for daemon installers (`installer-macos.ts`, `installer-linux.ts`, `installer-windows.ts`) will mock `child_process` calls and will not invoke real `launchctl`, `systemctl`, or `schtasks` commands.
- The `GitClient` tests will use a local bare repository rather than mocking `simple-git`, so that git integration is genuinely exercised rather than stubbed.
- The existing test files `src/config/schema.test.ts` and `src/core/sanitizer.test.ts` will be expanded rather than replaced.
- Platform-specific path behaviour on Windows is tested via the `AgentPaths` and `resolveDaemonSocketPath` logic only; no Windows CI runner is assumed.
- Performance targets assume a modern developer laptop; CI agents may apply a 2× time tolerance before considering a test slow.
