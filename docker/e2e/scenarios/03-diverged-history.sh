#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Verify AgentSync's fast-forward-only contract surfaces DIVERGED_HISTORY when
# the local vault has a commit AND the remote has an unrelated commit with the
# same parent. This is the genuine divergent state — concurrent stale pushes
# alone don't produce it (push's reconcile fast-forwards first), so we have to
# construct divergence by direct git surgery on the vault.

VAULT_PATH=/vault/diverged.git
VAULT_URL="file://${VAULT_PATH}"
MACHINE=/tmp/diverged-machine
MANIPULATOR=/tmp/diverged-manipulator

step "Initialize fresh bare vault"
rm -rf "$MACHINE" "$MANIPULATOR"
git init --bare "$VAULT_PATH" >/dev/null
git -C "$VAULT_PATH" symbolic-ref HEAD refs/heads/main
pass "vault ready"

step "Init machine + push initial state (vault @ C1)"
mkdir -p "$MACHINE/.claude"
echo "# initial content" > "$MACHINE/.claude/CLAUDE.md"
cd /app
HOME="$MACHINE" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
HOME="$MACHINE" bun run src/cli.ts push --message "C1: initial"
c1=$(git --git-dir="$VAULT_PATH" rev-parse HEAD)
pass "vault at C1=${c1:0:10}"

step "Create a LOCAL-ONLY commit in machine's vault (not yet pushed)"
cd "$MACHINE/.config/agentsync/vault"
echo "machine local-only" >> .gitignore
git -c user.email=local@test -c user.name=local add .
git -c user.email=local@test -c user.name=local commit -m "machine local-only commit" >/dev/null
local_only=$(git rev-parse HEAD)
pass "local commit ${local_only:0:10} (parent ${c1:0:10})"

step "Push a DIFFERENT commit to remote via a separate clone (simulates 3rd party / force-push)"
git clone "$VAULT_PATH" "$MANIPULATOR"
cd "$MANIPULATOR"
git checkout main
echo "manipulator content" > foo.txt
git -c user.email=man@test -c user.name=man add .
git -c user.email=man@test -c user.name=man commit -m "remote diverging commit" >/dev/null
git push origin main >/dev/null 2>&1
manipulator_head=$(git rev-parse HEAD)
pass "remote advanced to ${manipulator_head:0:10} (parent ${c1:0:10})"

step "VERIFY divergent setup: machine_local and remote both have C1 as parent, but differ"
cd "$MACHINE/.config/agentsync/vault"
[ "$(git rev-parse HEAD)" = "$local_only" ] || fail "machine vault not at local commit"
[ "$(git -C "$VAULT_PATH" rev-parse HEAD)" = "$manipulator_head" ] || fail "remote not at manipulator commit"
[ "$local_only" != "$manipulator_head" ] || fail "local and remote unexpectedly identical"
pass "divergent state confirmed"

step "Run agentsync push — must REJECT with DIVERGED_HISTORY guidance"
cd /app
set +e
push_output=$(HOME="$MACHINE" bun run src/cli.ts push --message "should fail" 2>&1)
push_exit=$?
set -e
echo "$push_output" | sed 's/^/    /'

step "CRITICAL: push exited non-zero"
[ "$push_exit" -ne 0 ] || fail "push succeeded silently — DIVERGED_HISTORY contract VIOLATED"
pass "push exit=$push_exit"

step "CRITICAL: error message references diverged/fast-forward (not generic git error)"
if echo "$push_output" | grep -qiE "diverg|fast-forward"; then
  pass "error message includes diverged-history guidance"
else
  fail "error message lacks diverged/fast-forward guidance — user has no recovery info"
fi

step "CRITICAL: vault HEAD remains the manipulator commit (not silently overwritten)"
final_remote=$(git --git-dir="$VAULT_PATH" rev-parse HEAD)
[ "$final_remote" = "$manipulator_head" ] || fail "vault HEAD changed despite rejected push: ${final_remote:0:10}"
pass "vault HEAD intact at ${final_remote:0:10}"

green ""
green "════════════════════════════════════════"
green "  ✓✓✓ DIVERGED-HISTORY SCENARIO PASSED"
green "════════════════════════════════════════"
