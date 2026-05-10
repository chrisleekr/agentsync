#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Simulate two machines (same user, different laptops) inside one container by
# swapping HOME between bun invocations. paths.ts captures HOME once per process,
# so each `bun run` gets its own isolated agent paths and ~/.config/agentsync.

VAULT_PATH=/vault/multi.git
VAULT_URL_MULTI="file://${VAULT_PATH}"

step "Initialize fresh bare vault for multi-machine scenario"
# Always wipe — state from a previous run would corrupt this scenario's
# assumptions (e.g., vault HEAD ancestry across multiple runs in one container).
rm -rf "${VAULT_PATH}"
git init --bare "${VAULT_PATH}" >/dev/null
git -C "${VAULT_PATH}" symbolic-ref HEAD refs/heads/main
pass "vault ready at ${VAULT_PATH}"

# ─── Machine A ────────────────────────────────────────────────────────────────
MACHINE_A=/tmp/machine-a
step "Machine A: populate fresh agent state in $MACHINE_A"
# Adapter-aware fixtures: pick fields each adapter actually syncs wholesale.
#   - CLAUDE.md    → claude adapter syncs whole file
#   - settings.json {hooks:...} → claude adapter syncs only the hooks subset
#   - Cursor settings.json {rules:...} → cursor adapter syncs only the rules field
rm -rf "$MACHINE_A"
mkdir -p "$MACHINE_A/.claude" "$MACHINE_A/.config/Cursor/User"
echo "# Machine A's CLAUDE.md — round-trip canary" > "$MACHINE_A/.claude/CLAUDE.md"
echo '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo from-A"}]}]}}' \
  > "$MACHINE_A/.claude/settings.json"
echo '{"rules":"shared rule from machine A"}' > "$MACHINE_A/.config/Cursor/User/settings.json"

step "Machine A: agentsync init + push"
cd /app
HOME="$MACHINE_A" bun run src/cli.ts init --remote "$VAULT_URL_MULTI" --branch main
HOME="$MACHINE_A" bun run src/cli.ts push --message "machine-a initial snapshot"
assert_file_exists "$MACHINE_A/.config/agentsync/key.txt"

# ─── Machine B (same user, different machine — reuses age key) ───────────────
MACHINE_B=/tmp/machine-b
step "Machine B: bootstrap empty agent state, copy A's age key (single-user-multi-machine)"
rm -rf "$MACHINE_B"
mkdir -p "$MACHINE_B/.config/agentsync"
cp "$MACHINE_A/.config/agentsync/key.txt" "$MACHINE_B/.config/agentsync/key.txt"
chmod 600 "$MACHINE_B/.config/agentsync/key.txt"
[ ! -f "$MACHINE_B/.config/Cursor/User/settings.json" ] || fail "Machine B started dirty"
pass "Machine B starts empty (no agent state)"

step "Machine B: init (clones existing vault using shared key)"
HOME="$MACHINE_B" bun run src/cli.ts init --remote "$VAULT_URL_MULTI" --branch main

step "Machine B: pull (decrypt + apply Machine A's state)"
HOME="$MACHINE_B" bun run src/cli.ts pull

# ─── Verify the round-trip ────────────────────────────────────────────────────
step "CRITICAL: Machine B has Machine A's state after pull (decryption round-trip)"
assert_file_exists "$MACHINE_B/.config/Cursor/User/settings.json"
assert_contains    "$MACHINE_B/.config/Cursor/User/settings.json" "shared rule from machine A"

step "CRITICAL: Cursor 'rules' field round-trips semantically (cursor adapter pretty-prints, so byte-diff would be wrong)"
a_rules=$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).rules)' "$MACHINE_A/.config/Cursor/User/settings.json")
b_rules=$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).rules)' "$MACHINE_B/.config/Cursor/User/settings.json")
if [ "$a_rules" = "$b_rules" ]; then
  pass "rules field semantic-identical: '$a_rules'"
else
  fail "Cursor rules field differs: A='$a_rules' B='$b_rules'"
fi

step "CRITICAL: Claude CLAUDE.md round-trips wholesale (full-file sync target)"
assert_file_exists "$MACHINE_B/.claude/CLAUDE.md"
assert_contains    "$MACHINE_B/.claude/CLAUDE.md" "round-trip canary"

step "CRITICAL: Claude hooks subset round-trips (settings.json hooks-only sync)"
assert_file_exists "$MACHINE_B/.claude/settings.json"
assert_contains    "$MACHINE_B/.claude/settings.json" "echo from-A"

green ""
green "════════════════════════════════════════"
green "  ✓✓✓ MULTI-MACHINE ROUND-TRIP PASSED"
green "════════════════════════════════════════"
