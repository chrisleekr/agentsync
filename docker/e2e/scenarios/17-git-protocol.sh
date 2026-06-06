#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Validate that AgentSync works through the unauthenticated git:// transport.
# The daemon runs *inside this same container* on 127.0.0.1:9418 to avoid the
# cross-container DNS quirk that occasionally surfaces on GitHub Actions
# runners — co-locating the daemon keeps the scenario hermetic and matches
# every other scenario's shape (no compose profile, no host-side prep).

GIT_REMOTE="git://127.0.0.1:9418/repo.git"
MACHINE_A=/tmp/gitproto-machine-a
MACHINE_B=/tmp/gitproto-machine-b
DAEMON_PID=""
DAEMON_LOG=$(mktemp)

cleanup() {
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -f "$DAEMON_LOG"
}
trap cleanup EXIT INT TERM HUP

# ─── Start an in-container git-daemon ────────────────────────────────────────

step "Start git-daemon on 127.0.0.1:9418 (in-container, --base-path=/vault)"
# --reuseaddr: forgive a stale TIME_WAIT if the previous run died mid-flight
# --export-all: skip per-repo git-daemon-export-ok marker (vault-init does not write one)
# --enable=receive-pack: allow push (default exposes upload-pack only)
# --informative-errors: clearer client-side errors than the default
# --timeout / --init-timeout: bound any pathological client hang to 30s
# Daemon and vault are both owned by uid 1001 (agent user; see Dockerfile.machine
# and vault-init's `chown -R 1001:1001 /vault`). If the agent uid changes,
# receive-pack will EACCES — keep them in sync.
git daemon \
  --reuseaddr \
  --base-path=/vault \
  --export-all \
  --enable=receive-pack \
  --informative-errors \
  --timeout=30 \
  --init-timeout=30 \
  --listen=127.0.0.1 \
  --port=9418 \
  /vault >"$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!

# ─── Liveness probe ──────────────────────────────────────────────────────────

step "Probe git-daemon liveness (10s wall-clock cap)"
# `git ls-remote` against a not-yet-listening daemon retries — cap each probe
# to 0.5s so the overall loop stays inside the advertised 10s wall-clock. Do
# NOT use --exit-code: an empty bare repo (no refs yet) is still "alive"; the
# first push creates refs.
set +e
SECONDS=0
probe_exit=1
while [ $SECONDS -lt 10 ]; do
  if probe_out=$(timeout 0.5s git ls-remote "$GIT_REMOTE" 2>&1); then
    probe_exit=0
    break
  fi
  sleep 0.5
done
set -e
echo "${probe_out:-<no output>}" | sed 's/^/    /'
if [ "$probe_exit" -ne 0 ]; then
  echo "── git-daemon log ──"
  sed 's/^/    /' "$DAEMON_LOG"
  fail "git-daemon did not become reachable at $GIT_REMOTE within 10s"
fi
pass "git-daemon reachable at $GIT_REMOTE"

# ─── Machine A: init + push through git:// ───────────────────────────────────

step "Machine A: plant minimal fixture + init against git:// remote"
rm -rf "$MACHINE_A" "$MACHINE_B"
mkdir -p "$MACHINE_A/.claude"
echo "# git-protocol round-trip canary" > "$MACHINE_A/.claude/CLAUDE.md"
cd /app
HOME="$MACHINE_A" bun run src/cli.ts init --remote "$GIT_REMOTE" --branch main

step "Machine A: push via git://"
HOME="$MACHINE_A" bun run src/cli.ts push --message "git-protocol seed"

step "Confirm remote advanced (ls-remote shows a HEAD ref)"
remote_head=$(git ls-remote "$GIT_REMOTE" refs/heads/main | awk '{print $1}')
[ -n "$remote_head" ] || fail "git daemon has no main ref after push"
pass "remote HEAD = ${remote_head:0:10}"

# ─── Machine B: clone via git:// using A's age key ───────────────────────────

step "Machine B: bootstrap empty HOME with shared age key"
mkdir -p "$MACHINE_B/.config/agentsync"
cp "$MACHINE_A/.config/agentsync/key.txt" "$MACHINE_B/.config/agentsync/key.txt"
chmod 600 "$MACHINE_B/.config/agentsync/key.txt"
HOME="$MACHINE_B" bun run src/cli.ts init --remote "$GIT_REMOTE" --branch main

step "Machine B: copy claude/ via git://"
copy_self "$MACHINE_B" claude/

step "CRITICAL: CLAUDE.md round-trips byte-equal A → B over git://"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".claude/CLAUDE.md"

banner "GIT-PROTOCOL"
