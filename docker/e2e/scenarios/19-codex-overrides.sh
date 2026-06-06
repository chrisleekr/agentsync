#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Pin the Codex adapter:
#   B17: AGENTS.override.md snapshots + restores alongside AGENTS.md
#   B18: ~/.codex/rules/*.md current behaviour (synced today — pinned here)
#   B22: skills canonical at $HOME/.agents/skills; legacy $HOME/.codex/skills
#        is still readable on push, but apply always writes to canonical.
# Themes and other never-sync siblings stay out of the vault.

VAULT_PATH=/vault/codex-ov.git
VAULT_URL="file://${VAULT_PATH}"

step "Fresh isolated vault"
fresh_bare_vault "$VAULT_PATH"

# ─── Machine A: plant fixtures and push ──────────────────────────────────────
A=/tmp/codex-ov-a
step "Machine A: clean slate at $A and plant Codex fixtures"
rm -rf "$A"
mkdir -p "$A/.codex/rules" \
         "$A/.codex/themes" \
         "$A/.agents/skills/sql-formatter" \
         "$A/.config/agentsync"

plant_fixture "home/.codex/AGENTS.md"                       "$A"
plant_fixture "home/.codex/AGENTS.override.md"              "$A"
plant_fixture "home/.codex/config.toml"                     "$A"
plant_fixture "home/.agents/skills/sql-formatter/SKILL.md"  "$A"

# Themes canary: never-sync, lives under fixtures/canaries.
cp /home/agent/fixtures/canaries/never-sync/.codex/themes/dark.tmTheme \
   "$A/.codex/themes/dark.tmTheme"

# .codex/rules/general.md — pinning B18 current behaviour.
cat > "$A/.codex/rules/general.md" <<'EOF'
# Codex general rule

Verify behaviour with tests before claiming a fix.
EOF

step "Machine A: init + push"
with_machine "$A" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
with_machine "$A" bun run src/cli.ts push --message "codex snapshot"
A_KEY="$A/.config/agentsync/key.txt"
assert_file_exists "$A_KEY"

# ─── Vault layout assertions ─────────────────────────────────────────────────
step "B17: vault carries both AGENTS.md AND AGENTS.override.md"
assert_in_vault "$VAULT_PATH" "codex/AGENTS.md.age"
assert_in_vault "$VAULT_PATH" "codex/AGENTS.override.md.age"

step "B22: skill from canonical \$HOME/.agents/skills landed in vault"
assert_in_vault "$VAULT_PATH" "codex/skills/sql-formatter.tar.age"

step "Vault excludes never-sync ~/.codex/themes content"
assert_not_in_vault "$VAULT_PATH" "codex/themes"

step "B18 pin: ~/.codex/rules/*.md IS synced (codex/rules/<name>.md.age)"
# Current adapter snapshots ~/.codex/rules/*.md. If a future change removes
# this, flip to assert_not_in_vault and update the comment so the intent
# stays loud.
assert_in_vault "$VAULT_PATH" "codex/rules/general.md.age"

# ─── Machine B: pull, then round-trip checks ─────────────────────────────────
B=/tmp/codex-ov-b
step "Machine B: clean clone with A's key"
rm -rf "$B"
mkdir -p "$B/.config/agentsync"
cp "$A_KEY" "$B/.config/agentsync/key.txt"
chmod 600 "$B/.config/agentsync/key.txt"

with_machine "$B" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
copy_self "$B" codex/

step "B17: both AGENTS.md and AGENTS.override.md materialize on B"
assert_file_exists "$B/.codex/AGENTS.md"
assert_file_exists "$B/.codex/AGENTS.override.md"
assert_round_trip  "$A" "$B" ".codex/AGENTS.md"
assert_round_trip  "$A" "$B" ".codex/AGENTS.override.md"

step "B22: canonical skill round-trips at \$HOME/.agents/skills"
diff -r "$A/.agents/skills/sql-formatter" "$B/.agents/skills/sql-formatter" \
  || fail "sql-formatter skill content differs after round-trip"
pass "sql-formatter skill round-trip diff -r clean"

step "Themes never-sync canary did NOT leak through to B"
assert_file_absent "$B/.codex/themes/dark.tmTheme"

step "B18 pin: codex rule round-trips to ~/.codex/rules/general.md"
assert_round_trip "$A" "$B" ".codex/rules/general.md"

# ─── B22 second leg: legacy ~/.codex/skills/ remains readable on push ────────
# Drop a SECOND skill at the legacy path and re-push from A. The codex adapter
# documents that the legacy location is honoured on read, while the canonical
# location wins on apply.
step "Plant legacy-path skill at \$HOME/.codex/skills/legacy-skill and re-push"
mkdir -p "$A/.codex/skills/legacy-skill"
cat > "$A/.codex/skills/legacy-skill/SKILL.md" <<'EOF'
---
name: legacy-skill
description: Lives at ~/.codex/skills to exercise B22 legacy read path
---
Legacy skill body.
EOF
with_machine "$A" bun run src/cli.ts push --message "codex legacy skill push"

step "B22: legacy skill from \$HOME/.codex/skills lands in vault under codex/skills/"
assert_in_vault "$VAULT_PATH" "codex/skills/legacy-skill.tar.age"
# Canonical skill from first push still present.
assert_in_vault "$VAULT_PATH" "codex/skills/sql-formatter.tar.age"

step "B22: pulling on B writes BOTH skills to canonical \$HOME/.agents/skills"
copy_self "$B" codex/
assert_dir_exists  "$B/.agents/skills/sql-formatter"
assert_dir_exists  "$B/.agents/skills/legacy-skill"
# Apply target is canonical only — legacy directory must NOT be re-created on B.
assert_file_absent "$B/.codex/skills/legacy-skill"

banner "CODEX OVERRIDES + LEGACY SKILL READ PATH (B17/B18/B22)"
