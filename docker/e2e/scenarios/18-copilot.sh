#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Pin the Copilot adapter surface end-to-end:
#   B15: agents stored as single `<name>.agent.md` files (NOT per-agent tars)
#   B16: instructions filename on disk is `copilot-instructions.md`
# The vault path for the instructions file is `copilot/instructions.md.age`
# (the on-disk filename is `copilot-instructions.md`; the adapter normalises
# the vault basename). This scenario also pins what is NOT synced today —
# lsp-config.json, settings.json, mcp-config.json — so an accidental
# extension surfaces as a failure here.

VAULT_PATH=/vault/copilot.git
VAULT_URL="file://${VAULT_PATH}"

step "Fresh isolated vault for copilot scenario"
fresh_bare_vault "$VAULT_PATH"

# ─── Machine A: plant fixtures and push ──────────────────────────────────────
A=/tmp/copilot-a
step "Machine A: clean slate at $A and plant Copilot fixtures"
rm -rf "$A"
mkdir -p "$A/.copilot/instructions" \
         "$A/.copilot/prompts" \
         "$A/.copilot/agents" \
         "$A/.copilot/skills/log-summariser" \
         "$A/.config/agentsync"

plant_fixture "home/.copilot/copilot-instructions.md"           "$A"
plant_fixture "home/.copilot/instructions/style.instructions.md" "$A"
plant_fixture "home/.copilot/prompts/refactor.prompt.md"         "$A"
plant_fixture "home/.copilot/agents/bug-triager.agent.md"        "$A"
plant_fixture "home/.copilot/skills/log-summariser/SKILL.md"     "$A"
plant_fixture "home/.copilot/lsp-config.json"                    "$A"

assert_file_exists "$A/.copilot/copilot-instructions.md"
assert_file_exists "$A/.copilot/agents/bug-triager.agent.md"
assert_file_exists "$A/.copilot/lsp-config.json"

step "Machine A: init + push"
with_machine "$A" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
with_machine "$A" bun run src/cli.ts push --message "copilot snapshot"
A_KEY="$A/.config/agentsync/key.txt"
assert_file_exists "$A_KEY"

# ─── Vault layout assertions ─────────────────────────────────────────────────
step "Vault stores instructions at copilot/instructions.md.age (adapter canonical)"
assert_in_vault "$VAULT_PATH" "copilot/instructions.md.age"

step "Vault stores Copilot agent as single .agent.md.age file (B15)"
assert_in_vault     "$VAULT_PATH" "copilot/agents/bug-triager.agent.md.age"
# Per-agent tar bundles would land at copilot/agents/<name>.tar.age — must not.
assert_not_in_vault "$VAULT_PATH" "copilot/agents/bug-triager.tar"

step "Vault contains copilot prompt, instructions/, and skill bundle"
assert_in_vault "$VAULT_PATH" "copilot/prompts/refactor.prompt.md.age"
assert_in_vault "$VAULT_PATH" "copilot/instructions/style.instructions.md.age"
assert_in_vault "$VAULT_PATH" "copilot/skills/log-summariser.tar.age"

step "Agent blob decrypts to plaintext markdown (NOT a tar bundle — B15)"
# Decrypt to a temp file so we can detect tar magic vs markdown headers
# without bash string truncation on NUL bytes (bash variables can't hold NUL).
TMP_AGENT=/tmp/copilot-agent-dec
vshow "$VAULT_PATH" "copilot/agents/bug-triager.agent.md.age" \
  | age -d -i "$A_KEY" > "$TMP_AGENT"
# Single-file shape proof: gzipped tar archives start with the gzip magic
# bytes 0x1f 0x8b. Markdown bodies (with or without YAML frontmatter) never do.
magic=$(head -c 2 "$TMP_AGENT" | od -A n -t x1 | tr -d ' \n')
if [ "$magic" = "1f8b" ]; then
  fail "agent vault blob is gzipped (tar bundle), not the single-file shape B15 mandates"
fi
pass "agent vault blob has no gzip magic — single-file shape confirmed"
DEC=$(cat "$TMP_AGENT")
# Body match is exact — copilot agents are wholesale-synced.
expected_body=$(cat /home/agent/fixtures/home/.copilot/agents/bug-triager.agent.md)
if [ "$DEC" = "$expected_body" ]; then
  pass "agent body byte-equal to fixture"
else
  fail "agent body differs from fixture"
fi

step "Vault does NOT contain unsupported Copilot surfaces"
# lsp-config.json is currently NOT in the adapter's collection set.
# If the adapter is extended to sync it, flip to assert_in_vault here.
assert_not_in_vault "$VAULT_PATH" "copilot/lsp-config"
# Legacy filename `copilot/copilot-instructions.md.age` must NOT appear —
# the adapter writes the vault entry as `instructions.md.age`.
assert_not_in_vault "$VAULT_PATH" "copilot/copilot-instructions.md"

# ─── Machine B: pull and assert layout on disk ───────────────────────────────
B=/tmp/copilot-b
step "Machine B: clean clone with A's key"
rm -rf "$B"
mkdir -p "$B/.config/agentsync"
cp "$A_KEY" "$B/.config/agentsync/key.txt"
chmod 600 "$B/.config/agentsync/key.txt"

with_machine "$B" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
with_machine "$B" bun run src/cli.ts pull

step "B16: Machine B materializes copilot-instructions.md at canonical filename"
assert_file_exists "$B/.copilot/copilot-instructions.md"
assert_round_trip  "$A" "$B" ".copilot/copilot-instructions.md"

step "B15: agent lands as single file, not a directory"
assert_file_exists "$B/.copilot/agents/bug-triager.agent.md"
[ ! -d "$B/.copilot/agents/bug-triager.agent.md" ] \
  || fail "B15 violation — agent restored as directory"
pass "agent restored as plain file"
assert_round_trip "$A" "$B" ".copilot/agents/bug-triager.agent.md"

step "Sub-directory artifacts round-trip"
assert_round_trip "$A" "$B" ".copilot/instructions/style.instructions.md"
assert_round_trip "$A" "$B" ".copilot/prompts/refactor.prompt.md"
assert_file_exists "$B/.copilot/skills/log-summariser/SKILL.md"

step "Unsupported Copilot files must NOT materialize on Machine B"
# lsp-config.json was planted on A and is not in the adapter's collection
# set today. If the adapter is extended, flip this to assert_file_exists.
assert_file_absent "$B/.copilot/lsp-config.json"
# settings.json / mcp-config.json — never planted on A, and a stray sibling
# on B after pull would mean the adapter invented a write target.
assert_file_absent "$B/.copilot/settings.json"
assert_file_absent "$B/.copilot/mcp-config.json"

banner "COPILOT ADAPTER SURFACE PINNED (B15 + B16)"
