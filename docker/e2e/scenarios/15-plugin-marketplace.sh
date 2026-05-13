#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Validate the Claude plugin subpath round-trip and the syncMarketplace toggle.
#
# Vault layout per src/agents/claude.ts:
#   claude/plugins/<plugin>/plugin.json.age
#   claude/plugins/<plugin>/commands/<name>.age
#   claude/plugins/<plugin>/agents/<name>.age
#   claude/plugins/<plugin>/hooks/<name>.age
#   claude/plugins/<plugin>/mcp.json.age
#   claude/plugins/<plugin>/skills/<skill>.tar.age
#   claude/marketplace.json.age   (only when claudePlugins.syncMarketplace = true)
#
# /home/agent is used as Machine A so the entrypoint-rsynced fixture (including
# the lefthook-runner plugin tree + marketplace.json) is already in place.

VAULT_PATH=/vault/plugin.git
VAULT_URL="file://${VAULT_PATH}"
MACHINE_A=/tmp/plugin-machine-a
MACHINE_B=/tmp/plugin-machine-b
PLUGIN=lefthook-runner

cd /app
fresh_bare_vault "$VAULT_PATH"
rm -rf "$MACHINE_A" "$MACHINE_B"
mkdir -p "$MACHINE_A"
rsync -a --exclude='*.bak' --exclude='*~' /home/agent/fixtures/home/ "$MACHINE_A/"

step "Confirm fixture-supplied plugin tree + marketplace are in place on Machine A"
assert_file_exists "$MACHINE_A/.claude/plugins/$PLUGIN/.claude-plugin/plugin.json"
assert_file_exists "$MACHINE_A/.claude/plugins/$PLUGIN/commands/run.md"
assert_file_exists "$MACHINE_A/.claude/plugins/$PLUGIN/agents/precommit-helper.md"
assert_file_exists "$MACHINE_A/.claude/plugins/$PLUGIN/skills/precommit/SKILL.md"
assert_file_exists "$MACHINE_A/.claude/plugins/$PLUGIN/hooks/PreToolUse.json"
assert_file_exists "$MACHINE_A/.claude/plugins/$PLUGIN/.mcp.json"
assert_file_exists "$MACHINE_A/.claude/.claude-plugin/marketplace.json"

# Clean any prior scenario state under the default vault dir so init writes
# a deterministic agentsync.toml. Other scenarios live under /tmp so this
# wipe stays narrow.
rm -rf "$MACHINE_A/.config/agentsync"

step "init + initial push (default syncMarketplace = false)"
cd /app
HOME="$MACHINE_A" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
HOME="$MACHINE_A" bun run src/cli.ts push --message "plugin tree without marketplace"

step "CRITICAL: vault contains every plugin subpath under claude/plugins/$PLUGIN/"
assert_in_vault "$VAULT_PATH" "claude/plugins/$PLUGIN/plugin.json.age"
assert_in_vault "$VAULT_PATH" "claude/plugins/$PLUGIN/commands/run.md.age"
assert_in_vault "$VAULT_PATH" "claude/plugins/$PLUGIN/agents/precommit-helper.md.age"
assert_in_vault "$VAULT_PATH" "claude/plugins/$PLUGIN/hooks/PreToolUse.json.age"
assert_in_vault "$VAULT_PATH" "claude/plugins/$PLUGIN/mcp.json.age"
# Skill bundles are tar.age (one archive per skill directory).
assert_in_vault "$VAULT_PATH" "claude/plugins/$PLUGIN/skills/precommit.tar.age"

step "CRITICAL: marketplace.json NOT in vault while syncMarketplace = false"
assert_not_in_vault "$VAULT_PATH" "claude/marketplace.json.age"

step "Flip syncMarketplace = true in vault config + re-push"
TOML="$MACHINE_A/.config/agentsync/vault/agentsync.toml"
assert_file_exists "$TOML"
# The default block written by init is `[claudePlugins]\nsyncMarketplace = false`.
# Flip in place. If the line ever moves, the sed expression fails fast and the
# scenario surfaces the schema drift instead of silently passing.
grep -qE '^syncMarketplace = false$' "$TOML" \
  || fail "expected 'syncMarketplace = false' line in $TOML — schema drifted"
sed -i 's/^syncMarketplace = false$/syncMarketplace = true/' "$TOML"
grep -qE '^syncMarketplace = true$' "$TOML" \
  || fail "post-edit toml missing the true value"
pass "toml flipped"

HOME="$MACHINE_A" bun run src/cli.ts push --message "enable marketplace sync"

step "CRITICAL: marketplace.json NOW in vault"
assert_in_vault "$VAULT_PATH" "claude/marketplace.json.age"

# ─── Machine B: prove pull round-trips every plugin subpath ──────────────────

step "Machine B: fresh HOME with shared age key, init + pull"
rm -rf "$MACHINE_B"
mkdir -p "$MACHINE_B/.config/agentsync"
cp "$MACHINE_A/.config/agentsync/key.txt" "$MACHINE_B/.config/agentsync/key.txt"
chmod 600 "$MACHINE_B/.config/agentsync/key.txt"
HOME="$MACHINE_B" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
HOME="$MACHINE_B" bun run src/cli.ts pull

step "Every plugin markdown subpath round-trips byte-equal A → B"
for rel in \
  ".claude/plugins/$PLUGIN/commands/run.md" \
  ".claude/plugins/$PLUGIN/agents/precommit-helper.md" \
  ".claude/plugins/$PLUGIN/skills/precommit/SKILL.md" ; do
  assert_round_trip "$MACHINE_A" "$MACHINE_B" "$rel"
done

step "Plugin JSON subpaths round-trip by field-eq (sanitizer re-stringifies on push)"
# JSON files go parse → normalize → sanitize → stringify, so byte-equal is too
# strict for plugin.json/PreToolUse.json/.mcp.json. We compare structurally.
for rel in \
  ".claude/plugins/$PLUGIN/.claude-plugin/plugin.json" \
  ".claude/plugins/$PLUGIN/hooks/PreToolUse.json" \
  ".claude/plugins/$PLUGIN/.mcp.json" ; do
  assert_field_eq "$MACHINE_A/$rel" "$MACHINE_B/$rel" "."
done

step "marketplace.json also lands on Machine B (syncMarketplace = true)"
assert_file_exists "$MACHINE_B/.claude/.claude-plugin/marketplace.json"
assert_contains "$MACHINE_B/.claude/.claude-plugin/marketplace.json" "lefthook-runner"

banner "PLUGIN-MARKETPLACE"
