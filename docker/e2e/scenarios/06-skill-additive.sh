#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Verify the additive contract for skills (CLAUDE.md):
#   - push ADDS skills, never removes them implicitly
#   - pull APPLIES skills, never deletes local ones absent from vault
#   - `skill remove` is the ONLY way to drop a skill from the vault
# This protects users from losing skill state to a stale push from another machine.

VAULT_PATH=/vault/skill.git
VAULT_URL="file://${VAULT_PATH}"
MACHINE=/tmp/skill-machine

step "Initialize fresh bare vault for skill scenario"
rm -rf "$MACHINE"
git init --bare "$VAULT_PATH" >/dev/null
git -C "$VAULT_PATH" symbolic-ref HEAD refs/heads/main

step "Init machine"
mkdir -p "$MACHINE/.claude/skills/canary-skill"
cat > "$MACHINE/.claude/skills/canary-skill/SKILL.md" <<'EOF'
# Canary Skill
A test skill used to verify the additive-contract invariant.
EOF
cd /app
HOME="$MACHINE" bun run src/cli.ts init --remote "$VAULT_URL" --branch main

step "Push — vault should now contain canary-skill artifact"
HOME="$MACHINE" bun run src/cli.ts push --message "add canary-skill"
vault_files=$(git --git-dir="$VAULT_PATH" ls-tree -r HEAD | awk '{print $4}')
echo "$vault_files" | sed 's/^/    /'
echo "$vault_files" | grep -q "canary-skill" \
  || fail "canary-skill missing from vault after push"
pass "canary-skill present in vault"

step "DELETE the local skill directory and push again"
rm -rf "$MACHINE/.claude/skills/canary-skill"
[ ! -d "$MACHINE/.claude/skills/canary-skill" ] || fail "local delete failed"
HOME="$MACHINE" bun run src/cli.ts push --message "after local skill deletion"

step "CRITICAL: vault STILL contains canary-skill (additive contract — push never removes)"
post_delete_files=$(git --git-dir="$VAULT_PATH" ls-tree -r HEAD | awk '{print $4}')
if echo "$post_delete_files" | grep -q "canary-skill"; then
  pass "canary-skill still in vault after local delete + push (additive)"
else
  fail "canary-skill REMOVED from vault by push — ADDITIVE CONTRACT VIOLATED"
fi

step "Use 'agentsync skill remove' — vault should drop canary-skill"
HOME="$MACHINE" bun run src/cli.ts skill remove claude canary-skill 2>&1 | sed 's/^/    /'

step "CRITICAL: vault no longer contains canary-skill (explicit removal honored)"
post_remove_files=$(git --git-dir="$VAULT_PATH" ls-tree -r HEAD | awk '{print $4}')
echo "$post_remove_files" | sed 's/^/    /'
if echo "$post_remove_files" | grep -q "canary-skill"; then
  fail "canary-skill STILL in vault after explicit 'skill remove' — removal broken"
else
  pass "canary-skill removed from vault by explicit skill remove"
fi

green ""
green "════════════════════════════════════════"
green "  ✓✓✓ SKILL-ADDITIVE SCENARIO PASSED"
green "════════════════════════════════════════"
