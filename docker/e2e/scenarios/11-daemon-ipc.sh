#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# The daemon's IPC server registers status and push (push-only in v2; pull is rejected).
# Protocol: newline-delimited {id, cmd, args} JSON (see src/core/ipc.ts).
# We exercise each via the real IpcClient to avoid encoding the wire format
# in this scenario (the _lib.sh daemon_ipc helper predates the {id,cmd}
# envelope and would not get a matching response).

VAULT_PATH=/vault/daemon.git
VAULT_URL="file://${VAULT_PATH}"
A=/tmp/daemon-machine
SOCK="$A/.config/agentsync/daemon.sock"
DAEMON_LOG=/tmp/daemon.log

# ── Helper: invoke IpcClient.send via bun, against HOME=$A's socket ──────────
ipc_call() {
  local cmd="$1"
  # `bun -e "<code>" arg1 arg2` puts the first positional in process.argv[2]
  # (argv[0] is bun, argv[1] is the eval marker). Use [argv.length - 1] so the
  # invocation is robust to bun's argv-shape across versions.
  ( cd /app && HOME="$A" bun -e '
    const {IpcClient} = await import("./src/core/ipc.ts");
    const {resolveDaemonSocketPath} = await import("./src/config/paths.ts");
    const c = new IpcClient();
    const cmd = process.argv[process.argv.length - 1];
    const r = await c.send(cmd, {}, resolveDaemonSocketPath());
    console.log(JSON.stringify(r));
  ' "$cmd" )
}

step "Fresh vault + initial state on machine A"
fresh_bare_vault "$VAULT_PATH"
rm -rf "$A"
# Daemon's startDaemon() registers watchers for every enabled agent's root
# dir; missing dirs throw and the daemon exits AFTER binding the IPC socket,
# leaving ipc_call to ENOENT. Materialise all watch targets so the daemon
# can run cleanly. (Watchers fire only on disk changes — empty is fine.)
mkdir -p "$A/.claude" "$A/.cursor" "$A/.codex" "$A/.copilot/instructions"
echo "# daemon-ipc canary" > "$A/.claude/CLAUDE.md"
plant_fixture home/.claude.json "$A"

with_machine "$A" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
with_machine "$A" bun run src/cli.ts push --message "pre-daemon baseline"

step "Start daemon in background"
( cd /app && HOME="$A" bun run src/cli.ts daemon _run ) > "$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!
info "daemon pid: $DAEMON_PID"

# shellcheck disable=SC2317
cleanup() {
  if kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

step "Wait for IPC socket to appear at $SOCK"
elapsed=0
while [ $elapsed -lt 10 ] && [ ! -S "$SOCK" ]; do
  sleep 1
  elapsed=$((elapsed + 1))
done
if [ ! -S "$SOCK" ]; then
  info "daemon log:"; sed 's/^/    /' "$DAEMON_LOG" || true
  fail "daemon socket never appeared after 10s"
fi
pass "daemon socket ready at $SOCK"

step "IPC: status returns JSON with pid"
status_resp=$(ipc_call status)
echo "$status_resp" | sed 's/^/    /'
echo "$status_resp" | jq -e '.ok == true' >/dev/null \
  || fail "status response not ok: $status_resp"
echo "$status_resp" | jq -e '.data.pid | numbers' >/dev/null \
  || fail "status response missing numeric data.pid: $status_resp"
pass "status response well-formed"

step "Mutate local state and ask daemon to push"
echo "# mutated body for daemon push" > "$A/.claude/CLAUDE.md"
head_before=$(git --git-dir="$VAULT_PATH" rev-parse HEAD)
push_resp=$(ipc_call push)
echo "$push_resp" | sed 's/^/    /'
echo "$push_resp" | jq -e '.ok == true' >/dev/null \
  || fail "push response not ok: $push_resp"

step "Vault HEAD advances within 30s (proves daemon ran the push)"
elapsed=0
while [ $elapsed -lt 30 ]; do
  head_now=$(git --git-dir="$VAULT_PATH" rev-parse HEAD)
  [ "$head_now" != "$head_before" ] && break
  sleep 1
  elapsed=$((elapsed + 1))
done
[ "$head_now" != "$head_before" ] || fail "vault HEAD unchanged after IPC push within 30s"
pass "vault advanced via IPC push: ${head_before:0:10} → ${head_now:0:10}"

step "IPC: pull is rejected — the daemon is push-only in v2"
pull_resp=$(ipc_call pull)
echo "$pull_resp" | sed 's/^/    /'
echo "$pull_resp" | jq -e '.ok == false' >/dev/null \
  || fail "expected pull to be rejected (push-only daemon): $pull_resp"
pass "pull verb is rejected"

step "Clean shutdown: SIGTERM the daemon"
kill -TERM "$DAEMON_PID"
elapsed=0
while [ $elapsed -lt 15 ] && kill -0 "$DAEMON_PID" 2>/dev/null; do
  sleep 1
  elapsed=$((elapsed + 1))
done
if kill -0 "$DAEMON_PID" 2>/dev/null; then
  fail "daemon did not exit within 15s of SIGTERM"
fi
pass "daemon exited cleanly"
trap - EXIT

banner "DAEMON IPC: STATUS / PUSH (pull rejected)"
