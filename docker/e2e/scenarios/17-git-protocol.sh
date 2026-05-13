#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Validate that AgentSync works through the unauthenticated git:// transport
# served by the compose `git-daemon` profile. The daemon is started by CI (or
# by docker/e2e/run-all.sh) before this scenario; if absent, fail fast with a
# clear remediation hint instead of hanging on a TCP connect retry.

GIT_REMOTE="git://git-daemon:9418/repo.git"
MACHINE_A=/tmp/gitproto-machine-a
MACHINE_B=/tmp/gitproto-machine-b

# ─── Liveness probe ──────────────────────────────────────────────────────────

step "Probe git-daemon liveness (10s timeout)"
set +e
# `git ls-remote` against a missing service hangs on connect; cap it. We do
# NOT use --exit-code here so an empty repo (no refs yet) is still treated as
# alive — the next `git init --bare` push will create refs.
probe_out=$(timeout 10s git ls-remote "$GIT_REMOTE" 2>&1)
probe_exit=$?
set -e
echo "$probe_out" | sed 's/^/    /'
if [ "$probe_exit" -ne 0 ]; then
  fail "Scenario 17 requires \`docker compose --profile git-daemon up -d git-daemon\` first."
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

step "Machine B: pull via git://"
HOME="$MACHINE_B" bun run src/cli.ts pull

step "CRITICAL: CLAUDE.md round-trips byte-equal A → B over git://"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".claude/CLAUDE.md"

banner "GIT-PROTOCOL"
