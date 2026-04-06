# Feature Specification: Stabilise Daemon Process

**Feature Branch**: `20260406-094347-stabilise-daemon`
**Created**: 2026-04-06
**Status**: Draft
**Input**: User description: "Stabilise daemon process"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Daemon Shuts Down Cleanly Without Data Loss (Priority: P1)

A developer or CI operator sends a stop signal (e.g. via `agentsync daemon stop` or system shutdown) to the background daemon. Any sync operation that is already in progress completes before the process exits. No partial writes are left behind, and the connection socket is removed so that subsequent start attempts do not hit stale-socket errors.

**Why this priority**: Unclean shutdown is the most common source of data corruption and "already in use" startup failures. Fixing this unblocks reliable restarts and service-manager integration.

**Independent Test**: Install the daemon, trigger a sync, immediately send SIGTERM, confirm the sync completed (or was safely abandoned), and confirm the socket path no longer exists and the next `daemon start` succeeds without error.

**Acceptance Scenarios**:

1. **Given** the daemon is running and a push is in progress, **When** SIGTERM is received, **Then** the push completes before the process exits and no partial commit is left in the vault.
2. **Given** the daemon is running, **When** SIGTERM or SIGINT is received, **Then** the IPC socket file is removed from disk before the process exits.
3. **Given** the daemon has previously crashed (leaving a stale socket), **When** the daemon is started again, **Then** it starts successfully without any manual cleanup required.

---

### User Story 2 - Sync Errors Are Visible and Actionable (Priority: P2)

An operator notices that syncs have been silently failing (no files updated across machines) and wants to diagnose the problem without having to read raw log files or attach a debugger. Each sync failure must be recorded with enough context to identify whether the root cause is a network issue, a conflict, or a configuration problem.

**Why this priority**: Silent failures erode user trust and make the daemon appear to work while no syncing is actually happening. Visible, actionable errors let operators self-diagnose.

**Independent Test**: Introduce a broken remote URL, run the daemon for one pull interval, check that `agentsync daemon status` or the log output reflects the failure, and confirm the daemon is still running for the next interval.

**Acceptance Scenarios**:

1. **Given** the daemon is running and the remote is unreachable, **When** the periodic pull fires, **Then** an error message is logged that includes the time, reason, and that the daemon remains alive for the next interval.
2. **Given** the daemon is running and a push triggered by a file-watch event fails, **Then** the error is logged with the affected path and the daemon continues watching for future changes.
3. **Given** multiple consecutive sync failures, **When** an operator queries daemon status, **Then** the response includes the count of recent failures and the most recent error message.

---

### User Story 3 - Daemon Recovers After a Transient Failure (Priority: P3)

A developer's machine temporarily loses network connectivity while the daemon is running. Once connectivity is restored, the daemon resumes syncing without requiring a manual restart.

**Why this priority**: Automatic recovery prevents a common "daemon is installed but not syncing" support scenario caused by laptops sleeping, network changes, or brief remote outages.

**Independent Test**: Start the daemon, simulate a network outage for two pull intervals, restore connectivity, and confirm the next pull interval succeeds and agent configs are up to date.

**Acceptance Scenarios**:

1. **Given** the daemon is running and the remote is temporarily unreachable, **When** the periodic pull fires and fails, **Then** the daemon retries the pull once immediately; if that also fails, it waits for the next scheduled interval and tries again.
2. **Given** the daemon is running and a file-watch push fails due to a transient error, **When** the push fails, **Then** the daemon retries the push once immediately; if that also fails, it logs the error and waits for the next file-change event.
3. **Given** the remote becomes reachable again after multiple failed intervals, **When** the next pull interval or file-change fires, **Then** the sync succeeds without a manual restart.

---

### User Story 4 - Daemon Startup Failures Are Clearly Reported (Priority: P4)

An operator runs `agentsync daemon install` on a new machine with an incomplete configuration (missing vault, missing encryption key). Instead of the daemon silently crashing or hanging, the failure is reported immediately with a clear message indicating what is wrong.

**Why this priority**: Silent startup failures lead to ghost services that appear installed but never sync. Clear startup errors reduce onboarding friction.

**Independent Test**: Install the daemon with a missing vault directory, check the service logs, and confirm an actionable error message is present within 5 seconds of start.

**Acceptance Scenarios**:

1. **Given** the daemon is started with a missing vault directory, **When** startup runs, **Then** the process exits with a non-zero code and logs a message identifying the missing vault.
2. **Given** the daemon is started with a missing or unreadable encryption key, **When** startup runs, **Then** the process exits with a non-zero code and logs a message identifying the key issue.
3. **Given** a valid configuration, **When** the daemon starts successfully, **Then** a "daemon started" message is logged within 2 seconds.

---

### Edge Cases

- What happens when a second daemon instance is started while one is already running (same socket path)?
- How does the daemon behave when the vault directory is deleted while it is running?
- When a push and a pull are triggered simultaneously, the second operation waits in a queue until the first completes (serialised — never concurrent).
- What happens when the daemon receives SIGKILL (unhandled, cannot be caught) — is the socket left behind?
- What happens when disk is full and a push cannot write the commit?
- What happens when the OS service manager (launchd/systemd) rejects the bootstrap registration during `daemon install`? (Confirmed cause: malformed ProgramArguments — executable and script path must be separate entries, not one space-joined string.)
- What happens when `daemon install` is run via `bunx` and the executable path is inside a session-scoped temp directory? The daemon will appear installed but fail silently after the temp directory is cleaned up.
- What happens when `daemon install` is run a second time on an already-registered service? (Confirmed cause: `launchctl bootstrap` on an already-loaded service returns error code 5; the fix is `bootout` then `bootstrap`.)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The daemon MUST complete any in-progress push or pull operation before exiting in response to a shutdown signal.
- **FR-002**: The daemon MUST remove its IPC socket file from disk as part of its shutdown sequence.
- **FR-003**: The daemon MUST start successfully when the IPC socket path already exists (stale from a previous crash), by removing it at startup.
- **FR-004**: The daemon MUST log each sync error with a timestamp, a human-readable error message, and the operation type (push or pull).
- **FR-005**: The daemon MUST remain running after a failed sync operation and continue processing future sync events and intervals.
- **FR-006**: The daemon MUST exit with a non-zero status code and log a descriptive error message when it cannot load its required configuration at startup.
- **FR-007**: The daemon MUST exit with a non-zero status code and log a descriptive error message when the vault directory or encryption key is missing or inaccessible at startup.
- **FR-008**: The `daemon status` IPC response MUST include the count of consecutive sync failures (reset to zero after any successful push or pull) and the most recent error message in addition to the process identifier.
- **FR-009**: The daemon MUST prevent a second instance from starting on the same socket path and report an "already running" error to the caller.
- **FR-010**: The daemon lifecycle MUST be documented with a Mermaid state diagram covering: starting, running, syncing, error, shutting down, and stopped states.
- **FR-011**: When `daemon install` fails because the OS service manager rejects bootstrap registration, the command MUST surface only the service manager's error message (not an internal stack trace), exit with a non-zero code, and print a short platform-specific hint to the operator (e.g. "Check that the executable path is valid" or "Try re-running with elevated privileges").
- **FR-012**: `daemon start` MUST verify that the service is registered with the OS service manager before attempting to start it; if not registered, the command MUST exit immediately with a non-zero code and the message "Service not bootstrapped — run `agentsync daemon install` first."
- **FR-013**: `daemon start` MUST apply a hard timeout (10 seconds) to the service manager start call; if the call does not return within that window, the command MUST kill the call, exit non-zero, and report "Service manager start timed out."
- **FR-014**: After any failed sync operation (push or pull), the daemon MUST retry that operation exactly once immediately before logging the failure and resuming its normal trigger cadence.
- **FR-015**: The daemon MUST serialise all sync operations through a single queue so that at most one push or pull executes at any given time; any operation triggered while another is running MUST wait until the running operation completes.
- **FR-016**: The installer MUST write the executable path and each of its arguments as **separate entries** in the service definition's program arguments list; combining the executable and arguments into a single space-separated string is not permitted, as the OS service manager (launchd/systemd) treats the first entry as the literal binary path. *(Root cause of the confirmed install failure: `ProgramArguments[0]` contained `"bun /path/cli.js"` instead of two separate entries.)*
- **FR-017**: Before writing the service definition, `daemon install` MUST verify that the resolved executable path refers to a file that exists and is executable at a stable, persistent location. If the path is inside a temporary or session-scoped directory, the command MUST abort with an error message explaining the issue and suggesting the user install the package globally instead.
- **FR-018**: `daemon install` MUST first remove any existing service registration before writing a new service definition and re-registering, so that re-running `daemon install` on an already-installed daemon never produces a "service already registered" error.

### Key Entities

- **Daemon Process**: The long-running background process responsible for watching agent config directories, executing periodic pulls, and responding to IPC commands. Tracks its own lifecycle state and error history.
- **IPC Socket**: The communication channel between the daemon and CLI commands. Created at startup, removed at shutdown. Path is deterministic per user account.
- **Sync Operation**: A single push or pull execution triggered either by a file-watch event, a periodic interval, or an explicit IPC command. Has a start time, completion status, and optional error message.
- **Failure Record**: A count of consecutive sync failures maintained in memory by the daemon since the last successful sync operation (push or pull). Resets to zero on any successful sync. Surfaced via the `status` IPC command along with the most recent error message.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The daemon shuts down cleanly (no stale socket, no partial commit) within 10 seconds of receiving a stop signal in 100% of observed cases.
- **SC-002**: After a clean shutdown and restart, `agentsync daemon status` returns a running response within 5 seconds in 100% of observed cases.
- **SC-003**: Every sync error is logged within 1 second of occurrence and includes enough information for an operator to identify the root cause without consulting source code.
- **SC-004**: The daemon continues running for at least 10 consecutive failed sync intervals without requiring a manual restart.
- **SC-005**: A second daemon start attempt on an already-running instance reports an "already running" error within 2 seconds and does not corrupt the running daemon's state.
- **SC-006**: Startup configuration errors are reported and the process exits within 3 seconds, with a log message that identifies the specific missing or invalid resource.
- **SC-007**: `daemon start` either succeeds or exits with an error within 10 seconds in 100% of observed cases — it MUST NOT block indefinitely.

## Assumptions

- The daemon runs under a single user account; multi-user or root-escalated installs are out of scope.
- The system service manager (launchd, systemd, NSSM) is responsible for automatic restart after an unrecoverable crash; the daemon itself only handles graceful shutdown and transient error recovery.
- Network connectivity is expected to be intermittent on developer machines; retry logic should not require any new configuration.
- The IPC socket path is fixed per user and does not need to be configurable in this feature.
- All sync operations (push and pull) are serialised through a queue; concurrent execution is explicitly not supported. Merge conflict resolution within a single operation is unchanged from the existing implementation.
- Windows named-pipe behaviour may differ from Unix socket behaviour in cleanup; platform-specific handling is acceptable as long as the observable outcomes match the acceptance scenarios.

## Clarifications

### Session 2026-04-06

- Q: When `daemon install` fails because the OS service manager rejects bootstrap registration, what should the command do? → A: Extract service manager stderr only, exit non-zero, and print a short platform-specific hint line (no internal stack trace).
- Q: What should `daemon start` do when the service manager call does not return promptly? → A: Check bootstrap registration state first (error immediately if not registered), then apply a hard timeout as a safety net on the kickstart/start call itself.
- Q: How should the daemon handle retries after a sync failure? → A: Retry immediately once after failure; if the retry also fails, wait for the next natural trigger (scheduled interval or file-change event).
- Q: When should the consecutive failure counter reset to zero? → A: Reset on any successful sync operation (push or pull).
- Q: When a push and pull are triggered at the same time, should they run concurrently or be serialised? → A: Serialise all sync operations — only one push or pull runs at a time.

### Investigation 2026-04-06 — Confirmed Root Causes from Live System

Three concrete bugs were confirmed by inspecting the installed plist, `launchctl print`, and system state:

1. **Malformed ProgramArguments** (`daemon.ts:10`, `installer-macos.ts:35`): `getExecutablePath()` returns `"bun /path/to/cli.js"` as a single concatenated string. `buildPlist()` places that entire string into one `<string>` XML element. launchd uses `ProgramArguments[0]` as the binary path; because no file exists at a path containing a space, every spawn attempt exits with `EX_CONFIG (78)`. Both log files are 0 bytes — the process never started. **Official requirement** (`launchd.plist(5)`): each element must be a separate `<string>` entry. Captured in FR-016.

2. **Ephemeral bunx temp path**: The installed plist references `/private/var/folders/.../T/bunx-501-.../node_modules/.../cli.js` — a session-scoped temp directory that bunx creates at runtime. This path is not persistent across OS restarts or temp-directory cleanups, making the daemon silently non-functional after reboot even if the plist format is corrected. Captured in FR-017.

3. **Re-bootstrap of already-registered service**: `installMacOs` calls `launchctl bootstrap` unconditionally. If the service is already registered, launchctl returns "Bootstrap failed: 5: Input/output error" with no distinction from a genuine failure. The correct pattern is `bootout` → write plist → `bootstrap`. Captured in FR-018.

## Documentation Impact

The daemon lifecycle is non-obvious to new contributors and operators. A Mermaid state diagram covering startup, running, syncing, error, graceful shutdown, and stopped states should be added to `docs/daemon.md` (or created if it does not exist) as part of this feature. The diagram must use GitHub-compatible Mermaid syntax.

Manual walkthrough reviewers should validate:
1. `agentsync daemon install && agentsync daemon stop` leaves no stale socket on disk.
2. Introducing a bad remote URL results in visible error logs and a still-running daemon after one pull interval.
3. `agentsync daemon status` output includes failure count after one failed pull.
