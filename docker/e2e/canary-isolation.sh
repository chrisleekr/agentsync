#!/usr/bin/env bash
# Host-side canary: snapshot mtimes/sizes of the directories Docker tests
# could *theoretically* mutate, then verify they are unchanged after a run.
#
# CAVEAT: if you have Claude Code, Cursor, or Codex running on the host while
# you snapshot/verify, the canary will report drift in their respective ~/.*
# dirs because those tools write session logs continuously. That is NOT a
# Docker leak — compose.yml has no host bind mounts and cannot touch host
# state. Run on an idle host (or in CI on a clean VM) for a clean signal.
#
# Usage:
#   ./canary-isolation.sh         # creates /tmp/agentsync-canary.snapshot
#   ./canary-isolation.sh verify  # diffs current state against snapshot
set -euo pipefail

WATCHED=(
  "$HOME/.claude"
  "$HOME/.cursor"
  "$HOME/.codex"
  "$HOME/.copilot"
  "$HOME/.config/agentsync"
  "$HOME/.config/Cursor"
  "$HOME/.config/Code"
  "$HOME/.npm"
  "$HOME/.bun"
)

SNAPSHOT="${SNAPSHOT_FILE:-/tmp/agentsync-canary.snapshot}"

stat_one() {
  local p="$1"
  if stat -f "%m %z %N" "$p" >/dev/null 2>&1; then
    stat -f "%m %z %N" "$p"
  else
    stat -c "%Y %s %n" "$p"
  fi
}

stat_path() {
  local p="$1"
  if [ ! -e "$p" ]; then
    echo "MISSING $p"
    return
  fi
  # Stat the entry itself, plus every contained file/dir up to depth 4.
  # Without recursion an in-file mutation would not change the parent dir's
  # mtime on macOS APFS or Linux ext4 in the relevant cases.
  if [ -d "$p" ]; then
    {
      stat_one "$p"
      find "$p" -maxdepth 4 -mindepth 1 -print0 2>/dev/null \
        | while IFS= read -r -d '' entry; do stat_one "$entry"; done
    } | sort
  else
    stat_one "$p"
  fi
}

capture() {
  for p in "${WATCHED[@]}"; do stat_path "$p"; done
}

mode="${1:-snapshot}"

if [ "$mode" = "snapshot" ]; then
  capture > "$SNAPSHOT"
  echo "[canary] baseline saved: $SNAPSHOT (${#WATCHED[@]} paths)"
  echo "[canary] now run: docker compose -f docker/e2e/compose.yml up --build --abort-on-container-exit"
  echo "[canary] then run: $0 verify"
elif [ "$mode" = "verify" ]; then
  [ -f "$SNAPSHOT" ] || { echo "[canary] no baseline at $SNAPSHOT — run without arg first"; exit 2; }
  current=$(mktemp)
  capture > "$current"
  if diff -u "$SNAPSHOT" "$current"; then
    echo "[canary] ✓ host paths unchanged — isolation intact"
    rm -f "$current"
  else
    echo "[canary] ✗ HOST STATE MUTATED — Docker harness leaked. Inspect compose volumes."
    rm -f "$current"
    exit 1
  fi
else
  echo "Usage: $0 [snapshot|verify]" >&2
  exit 2
fi
