#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Scenario 2 — round-trip every wholly-synced file byte-equal, and every
# subset-field file by field equality, between two machine homes sharing one
# age key.

VAULT_PATH=/vault/multi.git
VAULT_URL_MULTI="file://${VAULT_PATH}"

fresh_bare_vault "$VAULT_PATH"

MACHINE_A=/tmp/machine-a
MACHINE_B=/tmp/machine-b

step "Machine A: populate from fixture tree (the bootstrap rsync target)"
rm -rf "$MACHINE_A" "$MACHINE_B"
mkdir -p "$MACHINE_A"
rsync -a --exclude='*.bak' --exclude='*~' /home/agent/fixtures/home/ "$MACHINE_A/"
assert_file_exists "$MACHINE_A/.claude/CLAUDE.md"
assert_file_exists "$MACHINE_A/.codex/AGENTS.override.md"
assert_file_exists "$MACHINE_A/.copilot/agents/bug-triager.agent.md"
assert_file_exists "$MACHINE_A/.agents/skills/sql-formatter/SKILL.md"

step "Machine A: init + push"
cd /app
with_machine "$MACHINE_A" bun run src/cli.ts init --remote "$VAULT_URL_MULTI" --branch main
with_machine "$MACHINE_A" bun run src/cli.ts push --message "machine-a snapshot"

step "Machine B: clone vault using A's age key"
mkdir -p "$MACHINE_B/.config/agentsync"
cp "$MACHINE_A/.config/agentsync/key.txt" "$MACHINE_B/.config/agentsync/key.txt"
chmod 600 "$MACHINE_B/.config/agentsync/key.txt"
with_machine "$MACHINE_B" bun run src/cli.ts init --remote "$VAULT_URL_MULTI" --branch main
with_machine "$MACHINE_B" bun run src/cli.ts pull

# ─── Wholesale files — byte-equal round-trip ─────────────────────────────────
step "Wholesale markdown round-trips"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".claude/CLAUDE.md"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".claude/commands/deploy.md"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".claude/commands/review.md"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".claude/agents/code-reviewer.md"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".claude/agents/test-writer.md"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".claude/rules/coding-style.md"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".claude/rules/review-checklist.md"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".codex/AGENTS.md"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".codex/AGENTS.override.md"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".copilot/copilot-instructions.md"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".copilot/instructions/style.instructions.md"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".copilot/prompts/refactor.prompt.md"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".copilot/agents/bug-triager.agent.md"
assert_round_trip "$MACHINE_A" "$MACHINE_B" ".cursor/commands/refactor.md"

# ─── Subset-field semantics ──────────────────────────────────────────────────
step "Claude settings.json — hooks subset round-trips; sibling fields stay local-only"
assert_contains "$MACHINE_B/.claude/settings.json" "PreToolUse"
assert_field_eq "$MACHINE_A/.claude/settings.json" "$MACHINE_B/.claude/settings.json" ".hooks"
# Subset contract: only `hooks` travels through the vault. Machine B started
# empty, so `theme`, `model`, `permissions`, etc. must NOT have leaked through
# the pull (else the adapter regressed to wholesale-syncing settings.json).
for sibling in theme model permissions statusLine; do
  value=$(jq -c ".${sibling} // null" "$MACHINE_B/.claude/settings.json")
  if [ "$value" != "null" ]; then
    fail "settings.json sibling '$sibling' leaked into vault: $value"
  fi
done
pass "settings.json siblings absent on B (theme/model/permissions/statusLine)"

step "Claude .claude.json — mcpServers subset round-trips"
assert_field_eq "$MACHINE_A/.claude.json" "$MACHINE_B/.claude.json" ".mcpServers.filesystem"
assert_field_eq "$MACHINE_A/.claude.json" "$MACHINE_B/.claude.json" ".mcpServers.github"

step "Cursor mcp.json round-trips whole"
assert_field_eq "$MACHINE_A/.cursor/mcp.json" "$MACHINE_B/.cursor/mcp.json" ".mcpServers"

step "Cursor settings.json — rules field round-trips"
assert_field_eq "$MACHINE_A/.config/Cursor/User/settings.json" "$MACHINE_B/.config/Cursor/User/settings.json" ".rules"

step "VS Code mcp.json round-trips; settings/keybindings/snippets stay local-only"
assert_field_eq "$MACHINE_A/.config/Code/User/mcp.json" "$MACHINE_B/.config/Code/User/mcp.json" ".mcpServers"
# Pull on B does not write settings/keybindings/snippets unless they were in vault
# (which they aren't — VS Code adapter only syncs mcp.json). assert that on B
# the absence is fresh-machine reality (they weren't planted, won't be written):
if [ -e "$MACHINE_B/.config/Code/User/settings.json" ]; then
  fail "vscode settings.json leaked into B via pull"
fi
pass "vscode non-MCP files correctly absent on B"

banner "MULTI-MACHINE ROUND-TRIP"
