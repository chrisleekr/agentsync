#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Scenario 4 — table-driven coverage of the sanitizer aborts:
#   1. Literal-secret canaries: planting them inside a synced file must
#      cause push to exit non-zero and the vault must not contain the marker.
#   2. Never-sync canaries (auth.json, .credentials.json, .bak, *~, etc):
#      they sit in HOME but must not appear in vault.
#   3. cli-config absence — agentsync no longer bootstraps it (B1).

VAULT_PATH=/vault/sanitizer.git
VAULT_URL_S="file://${VAULT_PATH}"
MACHINE=/tmp/sanitizer
KEY="$MACHINE/.config/agentsync/key.txt"

cd /app
fresh_bare_vault "$VAULT_PATH"
rm -rf "$MACHINE"
mkdir -p "$MACHINE"
rsync -a --exclude='*.bak' --exclude='*~' /home/agent/fixtures/home/ "$MACHINE/"

step "Init the machine"
with_machine "$MACHINE" bun run src/cli.ts init --remote "$VAULT_URL_S" --branch main

# ─── Literal-secret canaries ─────────────────────────────────────────────────
step "Literal-secret canaries: push must abort"
for canary in /home/agent/fixtures/canaries/literal-secrets/*; do
  name=$(basename "$canary")
  info "  planting $name into ~/.cursor/mcp.json"

  # Snapshot vault HEAD so we can verify no new commit landed if abort works.
  pre_head=$(git --git-dir="$VAULT_PATH" rev-parse HEAD 2>/dev/null || echo NONE)

  cp "$canary" "$MACHINE/.cursor/mcp.json"

  if with_machine "$MACHINE" bun run src/cli.ts push --message "should-abort: $name" 2>&1; then
    fail "expected sanitizer abort for $name, push exited 0"
  fi
  pass "push aborted for $name"

  post_head=$(git --git-dir="$VAULT_PATH" rev-parse HEAD 2>/dev/null || echo NONE)
  [ "$pre_head" = "$post_head" ] || fail "vault advanced despite abort for $name"
done

# Restore the canonical fixture so subsequent steps have a clean cursor mcp.json
cp /home/agent/fixtures/home/.cursor/mcp.json "$MACHINE/.cursor/mcp.json"
pass "cursor mcp.json restored to clean fixture"

# ─── Never-sync canaries ────────────────────────────────────────────────────
step "Never-sync canaries: present in HOME but absent from vault after push"

# Plant the never-sync set (auth.json, credentials, settings.local, bak/tilde, etc.)
mkdir -p "$MACHINE/.codex" "$MACHINE/.codex/sessions" "$MACHINE/.codex/themes"
cp /home/agent/fixtures/canaries/never-sync/.codex/auth.json          "$MACHINE/.codex/auth.json"
cp /home/agent/fixtures/canaries/never-sync/.codex/history.jsonl      "$MACHINE/.codex/history.jsonl"
cp /home/agent/fixtures/canaries/never-sync/.codex/sessions/2026-05-13.jsonl "$MACHINE/.codex/sessions/2026-05-13.jsonl"
cp /home/agent/fixtures/canaries/never-sync/.codex/themes/dark.tmTheme "$MACHINE/.codex/themes/dark.tmTheme"
mkdir -p "$MACHINE/.claude/statsig"
cp /home/agent/fixtures/canaries/never-sync/.claude/.credentials.json "$MACHINE/.claude/.credentials.json"
cp /home/agent/fixtures/canaries/never-sync/.claude/settings.local.json "$MACHINE/.claude/settings.local.json"
cp /home/agent/fixtures/canaries/never-sync/.claude/statsig/state.json "$MACHINE/.claude/statsig/state.json"
cp /home/agent/fixtures/canaries/never-sync/NOTES.local.md            "$MACHINE/NOTES.local.md"
cp /home/agent/fixtures/canaries/never-sync/stale-copy.bak            "$MACHINE/.claude/stale-copy.bak"
cp /home/agent/fixtures/canaries/never-sync/editor-temp.md~           "$MACHINE/.claude/editor-temp.md~"

step "Push with never-sync canaries planted — should succeed (they get filtered)"
with_machine "$MACHINE" bun run src/cli.ts push --message "sanitizer: never-sync canaries"

step "Verify each canary is absent from the vault tree"
assert_not_in_vault "$VAULT_PATH" "auth.json"
assert_not_in_vault "$VAULT_PATH" ".credentials.json"
assert_not_in_vault "$VAULT_PATH" "settings.local.json"
assert_not_in_vault "$VAULT_PATH" "statsig"
assert_not_in_vault "$VAULT_PATH" "history.jsonl"
assert_not_in_vault "$VAULT_PATH" "sessions"
assert_not_in_vault "$VAULT_PATH" "themes"
assert_not_in_vault "$VAULT_PATH" ".bak"
# Editor backup files like `editor-temp.md~` get rsync-excluded by the entrypoint
# and ignored by the sanitizer; assert by the basename, not the trailing `~`
# substring (vault paths never contain `~`).
assert_not_in_vault "$VAULT_PATH" "editor-temp.md"
assert_not_in_vault "$VAULT_PATH" "NOTES.local.md"
assert_not_in_vault "$VAULT_PATH" "cli-config.json"

step "Decrypted-blob audit: none of the canary markers appear inside any blob"
assert_no_literal_in_vault "$VAULT_PATH" "$KEY" "canary-CCCCCC"
assert_no_literal_in_vault "$VAULT_PATH" "$KEY" "canary-DDDDDD"
assert_no_literal_in_vault "$VAULT_PATH" "$KEY" "canary-EEEEEE"
assert_no_literal_in_vault "$VAULT_PATH" "$KEY" "canary-FFFFFF-bak"
assert_no_literal_in_vault "$VAULT_PATH" "$KEY" "canary-GGGGGG-tilde"
assert_no_literal_in_vault "$VAULT_PATH" "$KEY" "sk-stub-canary-AAAAAA"
assert_no_literal_in_vault "$VAULT_PATH" "$KEY" "sk-canary-credential-BBBBBB"

banner "SANITIZER ABORTS + NEVER-SYNC + B21"
