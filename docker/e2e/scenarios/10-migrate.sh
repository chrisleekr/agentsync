#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# `agentsync migrate --from <a> --to <b> --type <t>` translates one agent's
# config to another's format. --dry-run must not mutate disk. A second
# real-mode invocation with unchanged source must be idempotent (same target
# content, no error). The CLI rejects unregistered (from,to,type) triples.
# Note: CLI flag is --type (not --kind); the supported types are
# global-rules | mcp | commands (see src/migrate/registry.ts).

MACHINE=/tmp/migrate-machine

reset_machine() {
  rm -rf "$MACHINE"
  mkdir -p "$MACHINE"
  # Source files for each migration subtest. We plant fresh per subtest so
  # idempotency tests don't see drift from a previous run.
  plant_fixture home/.claude/CLAUDE.md                  "$MACHINE"
  plant_fixture home/.claude.json                       "$MACHINE"
  plant_fixture home/.config/Cursor/User/settings.json  "$MACHINE"
  # Codex AGENTS.md may be created by a migration; ensure dir exists for tests
  # that read post-migrate output without colliding with a planted source.
}

# ── Subtest 1: claude → codex global-rules --dry-run ─────────────────────────
step "Subtest 1: migrate --from claude --to codex --type global-rules --dry-run"
reset_machine
rm -f "$MACHINE/.codex/AGENTS.md"
with_machine "$MACHINE" bun run src/cli.ts migrate --from claude --to codex --type global-rules --dry-run \
  2>&1 | tee /tmp/migrate-dry.log | sed 's/^/    /'
[ ! -f "$MACHINE/.codex/AGENTS.md" ] \
  || fail "dry-run wrote to ~/.codex/AGENTS.md — must be a no-op on disk"
pass "dry-run produced no file mutations"

# ── Subtest 2: claude → codex global-rules (real) ────────────────────────────
step "Subtest 2: migrate --from claude --to codex --type global-rules (real)"
with_machine "$MACHINE" bun run src/cli.ts migrate --from claude --to codex --type global-rules \
  2>&1 | sed 's/^/    /'
assert_file_exists "$MACHINE/.codex/AGENTS.md"
# Translated AGENTS.md should contain something derived from CLAUDE.md.
[ -s "$MACHINE/.codex/AGENTS.md" ] || fail "migrated AGENTS.md is empty"
pass "claude→codex global-rules wrote non-empty AGENTS.md"

# ── Subtest 3: idempotency — same source, same target content ───────────────
step "Subtest 3: re-run claude→codex global-rules is idempotent"
first_sha=$(sha256sum "$MACHINE/.codex/AGENTS.md" | awk '{print $1}')
with_machine "$MACHINE" bun run src/cli.ts migrate --from claude --to codex --type global-rules \
  2>&1 | sed 's/^/    /'
second_sha=$(sha256sum "$MACHINE/.codex/AGENTS.md" | awk '{print $1}')
[ "$first_sha" = "$second_sha" ] \
  || fail "second migrate produced different output: $first_sha vs $second_sha"
pass "re-run produced byte-identical AGENTS.md"

# ── Subtest 4: cursor → claude global-rules ──────────────────────────────────
step "Subtest 4: migrate --from cursor --to claude --type global-rules"
reset_machine
# Force a recognisable rules string into Cursor's settings so we can assert it
# made it into CLAUDE.md without altering cursor's settings.json.
CURSOR_RULES_BODY="MIGRATE_CANARY_CURSOR_RULES — be concise."
CURSOR_SETTINGS="$MACHINE/.config/Cursor/User/settings.json"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const body = process.argv[2];
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  s.rules = body;
  s.siblingSetting = "keep-me";
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
' "$CURSOR_SETTINGS" "$CURSOR_RULES_BODY"
cursor_settings_pre_sha=$(sha256sum "$CURSOR_SETTINGS" | awk '{print $1}')
rm -f "$MACHINE/.claude/CLAUDE.md"

with_machine "$MACHINE" bun run src/cli.ts migrate --from cursor --to claude --type global-rules \
  2>&1 | sed 's/^/    /'

assert_file_exists "$MACHINE/.claude/CLAUDE.md"
grep -q "$CURSOR_RULES_BODY" "$MACHINE/.claude/CLAUDE.md" \
  || fail "migrated CLAUDE.md missing canary rules body"
grep -q "migrated from Cursor" "$MACHINE/.claude/CLAUDE.md" \
  || fail "migrated CLAUDE.md missing 'migrated from Cursor' heading"

# Source must be byte-identical — the prior bug clobbered settings.json with
# the wrapped migration output and lost sibling fields.
cursor_settings_post_sha=$(sha256sum "$CURSOR_SETTINGS" | awk '{print $1}')
[ "$cursor_settings_pre_sha" = "$cursor_settings_post_sha" ] \
  || fail "cursor settings.json was modified by cursor→claude migration ($cursor_settings_pre_sha → $cursor_settings_post_sha)"

pass "cursor→claude wrote CLAUDE.md and left cursor settings.json untouched"

# ── Subtest 5: claude → cursor mcp ──────────────────────────────────────────
step "Subtest 5: migrate --from claude --to cursor --type mcp"
reset_machine
rm -f "$MACHINE/.cursor/mcp.json"
with_machine "$MACHINE" bun run src/cli.ts migrate --from claude --to cursor --type mcp \
  2>&1 | sed 's/^/    /'
assert_file_exists "$MACHINE/.cursor/mcp.json"
# Migrate's MCP translator parses through a shared model that preserves
# command + args + env but legitimately drops the source-specific `cwd`
# field (cursor schema doesn't expose it the same way). Compare only the
# fields the translator promises to carry through.
for server in filesystem github; do
  assert_field_eq "$MACHINE/.claude.json" "$MACHINE/.cursor/mcp.json" ".mcpServers.${server}.command"
  assert_field_eq "$MACHINE/.claude.json" "$MACHINE/.cursor/mcp.json" ".mcpServers.${server}.args"
done

banner "MIGRATE: GLOBAL-RULES + MCP"
