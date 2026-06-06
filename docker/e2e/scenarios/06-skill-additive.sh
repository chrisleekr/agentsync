#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Scenario 6 — pull is additive for skills: removing a skill from disk and
# pulling does not delete the vault's copy from disk; explicit
# `agentsync skill remove` is the only way to drop a skill from the vault.
# Plus: bundle content equality via tar_age_extract.

VAULT_PATH=/vault/skills.git
VAULT_URL_K="file://${VAULT_PATH}"
MACHINE_A=/tmp/skills-a
MACHINE_B=/tmp/skills-b
KEY_A="$MACHINE_A/.config/agentsync/key.txt"

cd /app
fresh_bare_vault "$VAULT_PATH"
rm -rf "$MACHINE_A" "$MACHINE_B"
mkdir -p "$MACHINE_A"
rsync -a --exclude='*.bak' --exclude='*~' /home/agent/fixtures/home/ "$MACHINE_A/"

step "Machine A init + push baseline state"
with_machine "$MACHINE_A" bun run src/cli.ts init --remote "$VAULT_URL_K" --branch main
with_machine "$MACHINE_A" bun run src/cli.ts push --message "skills baseline"

step "Verify postgres-helper skill bundle tar.age in vault"
assert_in_vault "$VAULT_PATH" "claude/skills/postgres-helper.tar.age"

step "tar_age_extract — bundle content equals source tree"
# Wipe the extraction target so a stale leftover from a previous local run
# can't sneak files into the diff comparison.
rm -rf /tmp/extracted-skill
mkdir -p /tmp/extracted-skill
tar_age_extract "$VAULT_PATH" "claude/skills/postgres-helper.tar.age" /tmp/extracted-skill "$KEY_A"
diff -r "$MACHINE_A/.claude/skills/postgres-helper" /tmp/extracted-skill || \
  fail "extracted bundle does not match source tree"
pass "tar.age contents byte-equal to disk skill"

step "Machine A: remove the skill locally and push"
rm -rf "$MACHINE_A/.claude/skills/postgres-helper"
with_machine "$MACHINE_A" bun run src/cli.ts push --message "skill removed from disk"

step "Additive contract: vault still contains postgres-helper.tar.age"
assert_in_vault "$VAULT_PATH" "claude/skills/postgres-helper.tar.age"

step "Machine B: clone vault using A's key — gets the skill back"
mkdir -p "$MACHINE_B/.config/agentsync"
cp "$KEY_A" "$MACHINE_B/.config/agentsync/key.txt"
chmod 600 "$MACHINE_B/.config/agentsync/key.txt"
with_machine "$MACHINE_B" bun run src/cli.ts init --remote "$VAULT_URL_K" --branch main
copy_self "$MACHINE_B" claude/
assert_dir_exists  "$MACHINE_B/.claude/skills/postgres-helper"
assert_file_exists "$MACHINE_B/.claude/skills/postgres-helper/SKILL.md"

step "agentsync skill remove — explicit removal from vault"
with_machine "$MACHINE_A" bun run src/cli.ts skill remove claude postgres-helper
assert_not_in_vault "$VAULT_PATH" "claude/skills/postgres-helper.tar.age"

banner "SKILL ADDITIVE + EXPLICIT REMOVE"
