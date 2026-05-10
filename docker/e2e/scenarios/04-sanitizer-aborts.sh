#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Verify AgentSync's push HARD-ABORTS when a literal secret is detected by the
# sanitizer. This is the strongest possible posture: the secret never gets
# encrypted, never lands in the vault, and the user gets an actionable error.
# Confirms that adapter-level redaction warnings escalate to a fatal abort
# in push.ts Phase 1.

VAULT_PATH=/vault/sanitizer.git
VAULT_URL="file://${VAULT_PATH}"
MACHINE=/tmp/sanitizer-machine
FAKE_SECRET="sk-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE"

step "Initialize fresh bare vault"
rm -rf "$MACHINE"
git init --bare "$VAULT_PATH" >/dev/null
git -C "$VAULT_PATH" symbolic-ref HEAD refs/heads/main

step "Plant a literal sk- secret inside cursor mcp.json"
mkdir -p "$MACHINE/.cursor"
cat > "$MACHINE/.cursor/mcp.json" <<EOF
{
  "mcpServers": {
    "test-server": {
      "command": "node",
      "env": {
        "OPENAI_API_KEY": "${FAKE_SECRET}"
      }
    }
  }
}
EOF
assert_contains "$MACHINE/.cursor/mcp.json" "$FAKE_SECRET"

step "agentsync init (init's own push contains no agent state yet, so it succeeds)"
cd /app
HOME="$MACHINE" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
init_head=$(git --git-dir="$VAULT_PATH" rev-parse HEAD)
pass "vault @ ${init_head:0:10} after init"

step "agentsync push (must ABORT — secret in mcp.json triggers sanitizer escalation)"
set +e
push_output=$(HOME="$MACHINE" bun run src/cli.ts push --message "should abort" 2>&1)
push_exit=$?
set -e
echo "$push_output" | sed 's/^/    /'

step "CRITICAL: push exited non-zero (sanitizer escalated to fatal)"
[ "$push_exit" -ne 0 ] || fail "push succeeded despite literal secret — sanitizer DID NOT abort"
pass "push exit=$push_exit"

step "CRITICAL: error mentions 'Push aborted' + 'security issue'"
echo "$push_output" | grep -qF "Push aborted"   || fail "no 'Push aborted' in error"
echo "$push_output" | grep -qF "security issue" || fail "no 'security issue' in error"
pass "abort message has expected content"

step "CRITICAL: error attributes the redaction (cursor adapter, field K = OPENAI_API_KEY)"
echo "$push_output" | grep -qiE "redact"   || fail "no redaction reference in abort message"
echo "$push_output" | grep -qF "[cursor]"  || fail "abort message doesn't identify the offending adapter"
pass "abort message attributes the source"

step "CRITICAL: vault HEAD unchanged (no new commit landed despite the abort)"
post_head=$(git --git-dir="$VAULT_PATH" rev-parse HEAD)
[ "$post_head" = "$init_head" ] \
  || fail "vault HEAD advanced from ${init_head:0:10} to ${post_head:0:10} — secret may have leaked into a commit"
pass "vault HEAD intact at ${post_head:0:10}"

step "CRITICAL: literal secret NEVER appears in any vault blob (proves abort happened pre-encryption)"
leak=$(git --git-dir="$VAULT_PATH" rev-list --objects --all | awk '{print $1}' | sort -u | \
       while read sha; do
         if git --git-dir="$VAULT_PATH" cat-file -p "$sha" 2>/dev/null | grep -qF "$FAKE_SECRET"; then
           echo "LEAK:$sha"
         fi
       done | grep '^LEAK:' || true)
[ -z "$leak" ] || fail "literal secret leaked to vault objects: $leak"
pass "no vault blob contains the literal secret"

green ""
green "════════════════════════════════════════"
green "  ✓✓✓ SANITIZER-ABORTS SCENARIO PASSED"
green "════════════════════════════════════════"
