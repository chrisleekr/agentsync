# Quickstart Validation: Stabilise Daemon Process

**Branch**: `20260406-094347-stabilise-daemon` | **Date**: 2026-04-06

This document defines the manual walkthrough steps reviewers must complete to validate this feature before merging.

---

## Testing Environment Guide

| Test layer | Recommended environment | Notes |
|------------|------------------------|-------|
| Unit tests (mocked `execFile`) | Any machine — local, CI, container | No OS-specific calls; runs identically everywhere |
| macOS integration (launchd) | Host macOS machine | Docker runs Linux containers — `launchd` does not exist inside them |
| Linux integration (systemd) | GitHub Actions `ubuntu-latest` runner, or a local Linux VM (UTM / Lima) | `systemctl --user` is unreliable in unprivileged Docker containers |
| Windows integration (Task Scheduler) | GitHub Actions `windows-latest` runner | `schtasks.exe` is present; no VM needed |

**Docker is not recommended for installer integration tests.** It does not provide launchd, and systemd user services require a privileged init that complicates containers without adding reliability.

---

## Prerequisites

- AgentSync installed globally: `bun install -g @chrisleekr/agentsync`
- A working vault (`agentsync init` completed, remote configured)
- macOS (for launchd scenarios), or adapt steps for Linux/systemd

---

## Scenario 1 — Fresh Install and Clean Status

1. Run `agentsync daemon install`
   - **Expect**: Success message. No stack trace. No "Bootstrap failed" error.
2. Run `agentsync daemon status`
   - **Expect**: "Daemon is running (pid: XXXXX)" with `consecutiveFailures: 0`
3. Run `launchctl print gui/$(id -u)/com.agentsync.daemon` (macOS)
   - **Expect**: `state = running` or `state = waiting`. `last exit code` should NOT be 78.

## Scenario 2 — Idempotent Re-install

1. With daemon already installed, run `agentsync daemon install` again
   - **Expect**: Success message. No "Bootstrap failed: 5" error.
2. Run `agentsync daemon status`
   - **Expect**: Daemon is running with a new PID.

## Scenario 3 — Install via Ephemeral Path is Blocked

1. Run `bunx --package @chrisleekr/agentsync@latest agentsync daemon install`
   - **Expect**: Error message: "Executable is in a temporary directory. Install the package globally first: `bun install -g @chrisleekr/agentsync`"
   - **Expect**: Non-zero exit code. No plist written.

## Scenario 4 — `daemon start` Does Not Hang

1. If daemon is not registered (no plist), run `agentsync daemon start`
   - **Expect**: Error within 2 seconds: "Service not bootstrapped — run `agentsync daemon install` first."
2. If daemon IS registered but the process is already running, run `agentsync daemon start`
   - **Expect**: Returns within 10 seconds.

## Scenario 5 — Graceful Shutdown Leaves No Stale Socket

1. Confirm daemon is running: `agentsync daemon status`
2. Run `agentsync daemon stop`
3. Check socket path: `ls $(agentsync daemon _socket-path 2>/dev/null || echo ~/.agentsync/daemon.sock)`
   - **Expect**: Socket file does NOT exist.
4. Run `agentsync daemon install` (fresh start)
   - **Expect**: Success — no "address already in use" error.

## Scenario 6 — Sync Errors Are Visible

1. Temporarily break the remote URL in `agentsync.toml` (e.g., `url = "file:///nonexistent"`)
2. Wait for one pull interval (or trigger via `agentsync push`)
3. Run `agentsync daemon status`
   - **Expect**: `consecutiveFailures >= 1`, `lastError` contains a non-empty message.
4. Restore the remote URL
5. Trigger a sync (change any agent config file)
   - **Expect**: Next `agentsync daemon status` shows `consecutiveFailures: 0`, `lastError: null`.

## Scenario 7 — `bun run check` Passes

Run `bun run check` on the branch with all changes applied.

- **Expect**: Typecheck, lint, and all tests pass with zero errors.
- **Expect**: Coverage ≥70% for all modified modules; ≥90% for security-critical modules (unchanged).

## Scenario 8 — Mermaid Diagram Renders Correctly

Open `docs/daemon.md` in a Markdown renderer that supports Mermaid (e.g., GitHub preview).

- **Expect**: The lifecycle state diagram renders without errors.
- **Expect**: All states (starting, running, syncing, error, shutting down, stopped) are visible.
