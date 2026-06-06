#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Pin: the vscode adapter only syncs the mcp.json file
# (~/.config/Code/User/mcp.json on linux → claude/../vscode/mcp.json.age in vault).
# settings.json, keybindings.json, and snippets/* are intentionally NOT synced.
# Source of truth: src/agents/vscode.ts snapshotVsCode only reads mcpJson.

VAULT_PATH=/vault/vscode.git
VAULT_URL="file://${VAULT_PATH}"
MACHINE_A=/home/agent
MACHINE_B=/tmp/vscode-machine-b
VSCODE_DIR=".config/Code/User"

step "Plant fresh bare vault for vscode scenario"
fresh_bare_vault "$VAULT_PATH"

step "Confirm fixture supplies the four VS Code files on Machine A"
assert_file_exists "$MACHINE_A/$VSCODE_DIR/mcp.json"
assert_file_exists "$MACHINE_A/$VSCODE_DIR/settings.json"
assert_file_exists "$MACHINE_A/$VSCODE_DIR/keybindings.json"
assert_file_exists "$MACHINE_A/$VSCODE_DIR/snippets/typescript.json"

# Clean any prior scenario state in the default vault dir.
rm -rf "$MACHINE_A/.config/agentsync"

step "init + push (vscode adapter must be enabled — default is false in schema)"
cd /app
HOME="$MACHINE_A" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
# Flip vscode = true so the adapter actually runs. Default is false per
# config/schema.ts AgentSyncConfigSchema.agents.vscode.
TOML="$MACHINE_A/.config/agentsync/vault/agentsync.toml"
grep -qE '^vscode = false$' "$TOML" \
  || fail "expected 'vscode = false' line in $TOML — agent default drifted"
sed -i 's/^vscode = false$/vscode = true/' "$TOML"
HOME="$MACHINE_A" bun run src/cli.ts push --message "vscode mcp-only seed"

step "CRITICAL: vault vscode/ subtree contains only mcp.json.age"
# Enumerate every vscode/ entry in HEAD. v2 prefixes paths with machines/<name>/,
# so match the agent-relative suffix and compare to the exact-expected single
# line so unintended siblings fail loud.
vscode_entries=$(git --git-dir="$VAULT_PATH" ls-tree -r --name-only HEAD \
  | grep -oE 'vscode/.*' || true)
echo "$vscode_entries" | sed 's/^/    /'
[ "$vscode_entries" = "vscode/mcp.json.age" ] \
  || fail "vscode/ contains more than the expected single mcp.json.age entry"
pass "vault vscode/ has exactly one entry: vscode/mcp.json.age"

step "CRITICAL: settings.json, keybindings.json, snippets/typescript.json absent from vault"
assert_not_in_vault "$VAULT_PATH" "vscode/settings.json"
assert_not_in_vault "$VAULT_PATH" "vscode/keybindings.json"
assert_not_in_vault "$VAULT_PATH" "vscode/snippets"

# ─── Machine B: pull restores ONLY mcp.json ──────────────────────────────────

step "Machine B: fresh HOME with shared age key, init + pull"
rm -rf "$MACHINE_B"
mkdir -p "$MACHINE_B/.config/agentsync"
cp "$MACHINE_A/.config/agentsync/key.txt" "$MACHINE_B/.config/agentsync/key.txt"
chmod 600 "$MACHINE_B/.config/agentsync/key.txt"
HOME="$MACHINE_B" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
# Mirror the syncMarketplace-style toggle: B's agentsync.toml is pulled from
# vault HEAD on init, so vscode=true already, no edit needed.
copy_self "$MACHINE_B" vscode/

step "CRITICAL: B has mcp.json, absent everything else"
assert_file_exists "$MACHINE_B/$VSCODE_DIR/mcp.json"
assert_file_absent "$MACHINE_B/$VSCODE_DIR/settings.json"
assert_file_absent "$MACHINE_B/$VSCODE_DIR/keybindings.json"
assert_file_absent "$MACHINE_B/$VSCODE_DIR/snippets/typescript.json"

# ─── Local-only files on A stay invisible to AgentSync ───────────────────────

step "Mutate A's settings.json — push --dry-run must NOT list it as a tracked change"
echo '{"editor.fontSize": 99}' > "$MACHINE_A/$VSCODE_DIR/settings.json"
set +e
dry_out=$(HOME="$MACHINE_A" bun run src/cli.ts push --dry-run 2>&1)
dry_exit=$?
set -e
echo "$dry_out" | sed 's/^/    /'
[ "$dry_exit" -eq 0 ] || fail "dry-run exit=$dry_exit"
if echo "$dry_out" | grep -F "Code/User/settings.json" | grep -qv "mcp.json"; then
  fail "dry-run flagged VS Code settings.json as a change — adapter scope leaked"
fi
pass "settings.json mutation correctly invisible to push"

banner "VSCODE-NON-MCP"
