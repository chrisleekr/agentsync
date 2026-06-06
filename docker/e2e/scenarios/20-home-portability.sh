#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# B24 — HOME path portability across machines with different $HOME values.
#
# Push from Machine A (HOME=/tmp/alpha) writes ${AGENTSYNC_HOME} placeholders
# into the encrypted JSON/TOML blobs. Pull on Machine B (HOME=/tmp/beta)
# rewrites the placeholders back to /tmp/beta on disk. Substrings under
# /etc, /opt, etc. are NOT rewritten, and markdown bodies stay verbatim
# because user prose is not normalised.

VAULT_PATH=/vault/portability.git
VAULT_URL="file://${VAULT_PATH}"
PLACEHOLDER='${AGENTSYNC_HOME}'

step "Fresh isolated vault"
fresh_bare_vault "$VAULT_PATH"

# ─── Machine A: HOME=/tmp/alpha ──────────────────────────────────────────────
A=/tmp/alpha
step "Machine A: clean $A and plant curated portability fixtures"
rm -rf "$A"
mkdir -p "$A/.claude" \
         "$A/.cursor" \
         "$A/.codex" \
         "$A/.claude/plugins/lefthook-runner/.claude-plugin" \
         "$A/.config/agentsync"

# ~/.claude.json — adapter syncs the mcpServers subset, normalising HOME paths.
# Both /etc and /opt entries are negative controls (not under HOME).
cat > "$A/.claude.json" <<'JSON'
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/alpha/projects/x"],
      "cwd": "/tmp/alpha/projects/x"
    },
    "etc": { "command": "/etc/hosts-helper", "args": ["/etc/hosts"] },
    "opt": { "cwd": "/opt/tool" }
  }
}
JSON

# ~/.cursor/mcp.json — cursor adapter syncs this wholesale (no subset).
cat > "$A/.cursor/mcp.json" <<'JSON'
{
  "mcpServers": {
    "local":  { "cwd": "/tmp/alpha/projects/y" },
    "system": { "cwd": "/etc/hosts" }
  }
}
JSON

# ~/.codex/config.toml — codex adapter parses TOML, normalises strings,
# stringifies on push and denormalises on apply (shallow merge).
cat > "$A/.codex/config.toml" <<'TOML'
model_instructions_file = "/tmp/alpha/.codex/AGENTS.md"

[mcp_servers.local]
cwd = "/tmp/alpha/srv/mcp"

[mcp_servers.opt]
cwd = "/opt/foo"
TOML

# Claude plugin manifest + .mcp.json (B24 plugin tree). Manifest discovery
# requires the .claude-plugin/plugin.json sentinel.
cat > "$A/.claude/plugins/lefthook-runner/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "lefthook-runner",
  "version": "0.1.0",
  "installPath": "/tmp/alpha/.claude/plugins/cache/lefthook-runner/0.1.0"
}
JSON

cat > "$A/.claude/plugins/lefthook-runner/.mcp.json" <<'JSON'
{
  "mcpServers": {
    "lefthook": { "cwd": "/tmp/alpha/.claude/plugins/lefthook-runner" }
  }
}
JSON

# CLAUDE.md — markdown body. Must stay verbatim through the round-trip:
# normaliseForVault touches JSON/TOML values inside adapters, not markdown.
cat > "$A/.claude/CLAUDE.md" <<'MD'
# CLAUDE.md

A literal path /tmp/alpha/project/foo appears in prose and must NOT be
rewritten. The portability rewriter only touches structured config.
MD

step "Machine A: init + push"
with_machine "$A" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
with_machine "$A" bun run src/cli.ts push --message "portability push from alpha"
A_KEY="$A/.config/agentsync/key.txt"
assert_file_exists "$A_KEY"

# ─── Vault-side: placeholder is what's encrypted, not the literal path ───────
step "Negative control: vault stores ${PLACEHOLDER} (not /tmp/alpha)"
DEC_CLAUDE_JSON=$(vshow "$VAULT_PATH" "claude/claude.json.age" \
  | age -d -i "$A_KEY")
case "$DEC_CLAUDE_JSON" in
  *"$PLACEHOLDER"*) pass "claude.json blob carries placeholder" ;;
  *)                fail "claude.json blob missing placeholder. body: $DEC_CLAUDE_JSON" ;;
esac
case "$DEC_CLAUDE_JSON" in
  *"/tmp/alpha"*) fail "claude.json blob leaked literal /tmp/alpha" ;;
  *)              pass "claude.json blob has no /tmp/alpha literal" ;;
esac
# /etc and /opt must remain unchanged inside the blob.
case "$DEC_CLAUDE_JSON" in
  *"/etc/hosts"*) pass "claude.json preserved /etc/hosts literal" ;;
  *)              fail "claude.json lost /etc/hosts literal" ;;
esac
case "$DEC_CLAUDE_JSON" in
  *"/opt/tool"*) pass "claude.json preserved /opt/tool literal" ;;
  *)             fail "claude.json lost /opt/tool literal" ;;
esac

# ─── Machine B: HOME=/tmp/beta, pulls and rewrites placeholders ──────────────
B=/tmp/beta
step "Machine B: clean clone with A's key (different HOME)"
rm -rf "$B"
mkdir -p "$B/.config/agentsync"
cp "$A_KEY" "$B/.config/agentsync/key.txt"
chmod 600 "$B/.config/agentsync/key.txt"

with_machine "$B" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
copy_self "$B" claude/

# ─── ~/.claude.json mcpServers ───────────────────────────────────────────────
step "B24: ~/.claude.json mcpServers rewritten to /tmp/beta"
assert_file_exists      "$B/.claude.json"
assert_path_rewritten   "$B/.claude.json" '.mcpServers.filesystem.cwd'     '/tmp/beta/'
assert_path_rewritten   "$B/.claude.json" '.mcpServers.filesystem.args[2]' '/tmp/beta/'
# Negative controls: /etc and /opt strings stay byte-equal.
assert_field_only       "$B/.claude.json" '.mcpServers.etc.command' '"/etc/hosts-helper"'
assert_field_only       "$B/.claude.json" '.mcpServers.etc.args[0]' '"/etc/hosts"'
assert_field_only       "$B/.claude.json" '.mcpServers.opt.cwd'     '"/opt/tool"'

# ─── ~/.cursor/mcp.json ──────────────────────────────────────────────────────
step "B24: ~/.cursor/mcp.json rewritten to /tmp/beta; /etc untouched"
assert_file_exists    "$B/.cursor/mcp.json"
assert_path_rewritten "$B/.cursor/mcp.json" '.mcpServers.local.cwd'  '/tmp/beta/'
assert_field_only     "$B/.cursor/mcp.json" '.mcpServers.system.cwd' '"/etc/hosts"'

# ─── ~/.codex/config.toml — parse via Bun (jq does not read TOML) ────────────
step "B24: ~/.codex/config.toml rewritten to /tmp/beta; /opt untouched"
assert_file_exists "$B/.codex/config.toml"
# Render TOML → JSON in a tmp file so jq assertions are reusable.
CFG_JSON=$(mktemp)
bun -e '
  const TOML = require("@iarna/toml");
  const fs = require("fs");
  const obj = TOML.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.writeFileSync(process.argv[2], JSON.stringify(obj));
' "$B/.codex/config.toml" "$CFG_JSON"
assert_path_rewritten "$CFG_JSON" '.model_instructions_file'    '/tmp/beta/'
assert_path_rewritten "$CFG_JSON" '.mcp_servers.local.cwd'      '/tmp/beta/'
assert_field_only     "$CFG_JSON" '.mcp_servers.opt.cwd'        '"/opt/foo"'
rm -f "$CFG_JSON"

# ─── Plugin manifest + .mcp.json ─────────────────────────────────────────────
step "B24: plugin manifest installPath rewritten on B"
PLUGIN_MANIFEST="$B/.claude/plugins/lefthook-runner/.claude-plugin/plugin.json"
assert_file_exists    "$PLUGIN_MANIFEST"
assert_path_rewritten "$PLUGIN_MANIFEST" '.installPath' '/tmp/beta/'

step "B24: plugin .mcp.json cwd rewritten on B"
PLUGIN_MCP="$B/.claude/plugins/lefthook-runner/.mcp.json"
assert_file_exists    "$PLUGIN_MCP"
assert_path_rewritten "$PLUGIN_MCP" '.mcpServers.lefthook.cwd' '/tmp/beta/'

# ─── Markdown bodies are NEVER rewritten ─────────────────────────────────────
step "B24: CLAUDE.md prose preserved byte-equal (markdown is user content)"
assert_file_exists "$B/.claude/CLAUDE.md"
assert_contains    "$B/.claude/CLAUDE.md" "/tmp/alpha/project/foo"
assert_round_trip  "$A" "$B" ".claude/CLAUDE.md"

banner "HOME PATH PORTABILITY (B24)"
