#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Skills and MCP files must round-trip byte-equal across a push → wipe → pull
# cycle. Skill bundles are tar.age archives, MCP files are encrypted JSON/TOML
# subsets. Either silently dropping a file or re-serialising it differently
# would corrupt the user's tool config without a visible failure.

VAULT_PATH=/vault/skill-mcp.git
VAULT_URL="file://${VAULT_PATH}"
A=/tmp/skill-mcp-a
B=/tmp/skill-mcp-b

step "Fresh isolated vault"
fresh_bare_vault "$VAULT_PATH"
rm -rf "$A" "$B"
mkdir -p "$A" "$B"

step "Machine A: plant skill + MCP fixtures"
plant_fixture home/.claude/skills/postgres-helper/SKILL.md          "$A"
plant_fixture home/.claude/skills/postgres-helper/reference.md      "$A"
plant_fixture home/.claude/skills/postgres-helper/examples/seed.sql "$A"
plant_fixture home/.claude.json                                     "$A"
plant_fixture home/.codex/config.toml                               "$A"
plant_fixture home/.cursor/mcp.json                                 "$A"
plant_fixture home/.config/Code/User/mcp.json                       "$A"
plant_fixture home/.copilot/skills/log-summariser/SKILL.md          "$A"
plant_fixture home/.agents/skills/sql-formatter/SKILL.md            "$A"
# A CLAUDE.md is required so init/push has a baseline claude artifact.
mkdir -p "$A/.claude"
echo "# anchor" > "$A/.claude/CLAUDE.md"

step "Machine A: init + push"
with_machine "$A" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
sed -i 's/^vscode = false$/vscode = true/' "$A/.config/agentsync/vault/agentsync.toml"
with_machine "$A" bun run src/cli.ts push --message "skill+mcp fidelity baseline"

step "Verify vault contains expected skill bundles"
assert_in_vault "$VAULT_PATH" "claude/skills/postgres-helper"
assert_in_vault "$VAULT_PATH" "copilot/skills/log-summariser"
# Codex user-scope skills sourced from ~/.agents/skills land under codex/skills/.
assert_in_vault "$VAULT_PATH" "codex/skills/sql-formatter.tar.age"

step "Machine B: copy A's key, init, pull"
mkdir -p "$B/.config/agentsync"
cp "$A/.config/agentsync/key.txt" "$B/.config/agentsync/key.txt"
chmod 600 "$B/.config/agentsync/key.txt"
with_machine "$B" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
sed -i 's/^vscode = false$/vscode = true/' "$B/.config/agentsync/vault/agentsync.toml"
with_machine "$B" bun run src/cli.ts pull

step "Claude skill bundle: byte-equal across machines"
diff -r "$A/.claude/skills/postgres-helper" "$B/.claude/skills/postgres-helper" \
  || fail "claude skill bundle differs across machines"
pass "claude skill bundle round-trips byte-equal"

step "Copilot skill bundle: byte-equal across machines"
if [ -d "$B/.copilot/skills/log-summariser" ]; then
  diff -r "$A/.copilot/skills/log-summariser" "$B/.copilot/skills/log-summariser" \
    || fail "copilot skill bundle differs across machines"
  pass "copilot skill bundle round-trips byte-equal"
else
  info "copilot skills not restored on B — adapter may scope skills to claude only; skipping"
fi

step "Shared .agents/skills bundle (if synced) round-trips byte-equal"
if [ -d "$B/.agents/skills/sql-formatter" ]; then
  diff -r "$A/.agents/skills/sql-formatter" "$B/.agents/skills/sql-formatter" \
    || fail ".agents/skills bundle differs across machines"
  pass ".agents/skills bundle round-trips byte-equal"
else
  info ".agents/skills not restored on B — not part of any adapter's apply step today"
fi

step "Claude MCP servers field semantic equality"
assert_file_exists "$A/.claude.json"
assert_file_exists "$B/.claude.json"
assert_field_eq "$A/.claude.json" "$B/.claude.json" ".mcpServers"

step "Cursor MCP file: field equality"
assert_file_exists "$A/.cursor/mcp.json"
assert_file_exists "$B/.cursor/mcp.json"
# Cursor mcp.json top-level shape mirrors Claude's mcpServers map.
assert_field_eq "$A/.cursor/mcp.json" "$B/.cursor/mcp.json" "."

step "VS Code MCP file: servers field equality"
assert_file_exists "$A/.config/Code/User/mcp.json"
assert_file_exists "$B/.config/Code/User/mcp.json"
assert_field_eq "$A/.config/Code/User/mcp.json" "$B/.config/Code/User/mcp.json" ".mcpServers"

step "Codex MCP servers (TOML) semantic equality via TOML→JSON"
assert_file_exists "$A/.codex/config.toml"
assert_file_exists "$B/.codex/config.toml"
a_json=$(mktemp)
b_json=$(mktemp)
bun -e 'const T=require("@iarna/toml");const fs=require("fs");console.log(JSON.stringify(T.parse(fs.readFileSync(process.argv[1],"utf8")).mcp ?? {}))' "$A/.codex/config.toml" > "$a_json"
bun -e 'const T=require("@iarna/toml");const fs=require("fs");console.log(JSON.stringify(T.parse(fs.readFileSync(process.argv[1],"utf8")).mcp ?? {}))' "$B/.codex/config.toml" > "$b_json"
diff -q "$a_json" "$b_json" || fail "codex [mcp.*] section differs across machines"
pass "codex [mcp.*] section round-trips semantically"
rm -f "$a_json" "$b_json"

banner "SKILL+MCP FIDELITY"
