#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

VAULT_PATH=/vault/opencode.git
VAULT_URL="file://${VAULT_PATH}"
OPEN_CODE_ENV=(
  OPENCODE_DISABLE_EXTERNAL_SKILLS=true
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=true
)

step "Fresh isolated vault for OpenCode scenario"
fresh_bare_vault "$VAULT_PATH"

A=/tmp/opencode-a
step "Machine A: plant supported global OpenCode filesystem sources"
rm -rf "$A"
mkdir -p "$A/.config/agentsync" \
         "$A/.config/opencode/commands/team" \
         "$A/.config/opencode/agents" \
         "$A/.config/opencode/skills/helper/references"

cat > "$A/.config/opencode/opencode.jsonc" <<EOF
{
  // source comment
  "apiKey": "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "shared": "from-a",
  "path": "$A/bin"
}
EOF
cat > "$A/.config/opencode/tui.jsonc" <<'EOF'
{
  // TUI comment
  "scroll_speed": 2,
}
EOF
echo "# OpenCode global instructions" > "$A/.config/opencode/AGENTS.md"
echo "# Team review command" > "$A/.config/opencode/commands/team/review.md"
cat > "$A/.config/opencode/agents/reviewer.md" <<'EOF'
---
description: Reviews changes
---
Review the current changes.
EOF
cat > "$A/.config/opencode/skills/helper/SKILL.md" <<'EOF'
---
name: helper
description: OpenCode helper skill
---
Use the bundled reference.
EOF
echo "reference body" > "$A/.config/opencode/skills/helper/references/notes.md"

step "Machine A: opt in, redact, and push only OpenCode"
with_machine "$A" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
with_machine "$A" bun run src/cli.ts config set agents.opencode true
with_machine "$A" bun run src/cli.ts config set security.secretScan redact
with_machine "$A" env "${OPEN_CODE_ENV[@]}" \
  bun run src/cli.ts push --agent opencode --message "opencode snapshot"
A_KEY="$A/.config/agentsync/key.txt"

step "Vault preserves OpenCode origins, recursive artifacts, and native skill bundles"
assert_in_vault "$VAULT_PATH" "opencode/default/opencode.jsonc.age"
assert_in_vault "$VAULT_PATH" "opencode/default/tui.jsonc.age"
assert_in_vault "$VAULT_PATH" "opencode/default/AGENTS.md.age"
assert_in_vault "$VAULT_PATH" "opencode/default/commands/team/review.md.age"
assert_in_vault "$VAULT_PATH" "opencode/default/agents/reviewer.md.age"
assert_in_vault "$VAULT_PATH" "opencode/default/skills/helper.tar.age"

DECRYPTED_CONFIG=/tmp/opencode-config.jsonc
vshow "$VAULT_PATH" "opencode/default/opencode.jsonc.age" \
  | age -d -i "$A_KEY" > "$DECRYPTED_CONFIG"
assert_contains "$DECRYPTED_CONFIG" '$AGENTSYNC_REDACTED_APIKEY'
assert_contains "$DECRYPTED_CONFIG" '${AGENTSYNC_HOME}/bin'
assert_not_contains "$DECRYPTED_CONFIG" 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

EXTRACTED_SKILL=/tmp/opencode-skill
rm -rf "$EXTRACTED_SKILL"
tar_age_extract "$VAULT_PATH" "opencode/default/skills/helper.tar.age" \
  "$EXTRACTED_SKILL" "$A_KEY"
assert_file_exists "$EXTRACTED_SKILL/SKILL.md"
assert_contains "$EXTRACTED_SKILL/references/notes.md" "reference body"

B=/tmp/opencode-b
step "Machine B: initialise without implicitly restoring OpenCode"
rm -rf "$B"
mkdir -p "$B/.config/agentsync" "$B/.config/opencode"
cp "$A_KEY" "$B/.config/agentsync/key.txt"
chmod 600 "$B/.config/agentsync/key.txt"
with_machine "$B" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
assert_file_absent "$B/.config/opencode/commands/team/review.md"

cat > "$B/.config/opencode/opencode.jsonc" <<'EOF'
{
  // local comment
  "apiKey": "sk-local-real-value-aaaaaaaaaaaa",
  "localOnly": true,
  "shared": "old"
}
EOF

step "Machine B: explicitly copy the OpenCode namespace"
with_machine "$B" env "${OPEN_CODE_ENV[@]}" \
  bun run src/cli.ts copy self opencode/

step "JSONC restore is additive, path-portable, and secret-preserving"
assert_contains "$B/.config/opencode/opencode.jsonc" "// local comment"
assert_contains "$B/.config/opencode/opencode.jsonc" '"localOnly": true'
assert_contains "$B/.config/opencode/opencode.jsonc" '"apiKey": "sk-local-real-value-aaaaaaaaaaaa"'
assert_contains "$B/.config/opencode/opencode.jsonc" '"shared": "from-a"'
assert_contains "$B/.config/opencode/opencode.jsonc" "$B/bin"

step "Recursive Markdown and skill sidecars restore only after explicit copy"
assert_round_trip "$A" "$B" ".config/opencode/AGENTS.md"
assert_round_trip "$A" "$B" ".config/opencode/commands/team/review.md"
assert_round_trip "$A" "$B" ".config/opencode/agents/reviewer.md"
assert_round_trip "$A" "$B" ".config/opencode/tui.jsonc"
assert_round_trip "$A" "$B" ".config/opencode/skills/helper/SKILL.md"
assert_round_trip "$A" "$B" ".config/opencode/skills/helper/references/notes.md"

banner "OPENCODE GLOBAL FILESYSTEM BACKUP + EXPLICIT COPY"
