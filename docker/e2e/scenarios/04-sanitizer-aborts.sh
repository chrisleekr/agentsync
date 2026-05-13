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
# JSON-shaped canaries plant into ~/.cursor/mcp.json (must parse as JSON to
# reach the field-level redactor); non-JSON canaries plant into a markdown
# body (~/.claude/rules/canary.md) so the markdown-body scanner catches them.
for canary in /home/agent/fixtures/canaries/literal-secrets/*; do
  name=$(basename "$canary")
  pre_head=$(git --git-dir="$VAULT_PATH" rev-parse HEAD 2>/dev/null || echo NONE)

  case "$name" in
    *.json)
      info "  planting $name into ~/.cursor/mcp.json"
      cp "$canary" "$MACHINE/.cursor/mcp.json"
      ;;
    *)
      info "  planting $name into ~/.claude/rules/canary.md (markdown-body scan)"
      mkdir -p "$MACHINE/.claude/rules"
      cp "$canary" "$MACHINE/.claude/rules/canary.md"
      ;;
  esac

  if with_machine "$MACHINE" bun run src/cli.ts push --message "should-abort: $name" 2>&1; then
    fail "expected sanitizer abort for $name, push exited 0"
  fi
  pass "push aborted for $name"

  post_head=$(git --git-dir="$VAULT_PATH" rev-parse HEAD 2>/dev/null || echo NONE)
  [ "$pre_head" = "$post_head" ] || fail "vault advanced despite abort for $name"

  # Reset to a clean planting surface for the next iteration.
  rm -f "$MACHINE/.claude/rules/canary.md"
done

# Restore the canonical fixture so subsequent steps have a clean cursor mcp.json
cp /home/agent/fixtures/home/.cursor/mcp.json "$MACHINE/.cursor/mcp.json"
pass "cursor mcp.json restored to clean fixture"

# ─── Never-sync canaries ────────────────────────────────────────────────────
step "Never-sync canaries: present in HOME but absent from vault after push"

# Plant the never-sync set. Each canary is materialised by writing the
# marker string directly rather than copying from the fixture tree — Docker
# BuildKit was observed to drop some deeply-nested dotted-directory canary
# paths even with a permissive .dockerignore, and we'd rather assert the
# never-sync contract from a known-present payload than chase image-build
# inconsistencies that don't affect the contract under test.
mkdir -p "$MACHINE/.codex/sessions" "$MACHINE/.codex/themes" \
         "$MACHINE/.claude/statsig"
printf '%s' '{"OPENAI_API_KEY": "sk-stub-canary-AAAAAA"}'         > "$MACHINE/.codex/auth.json"
printf 'first\nsecond\nthird\n'                                    > "$MACHINE/.codex/history.jsonl"
printf '{"session": "canary"}\n'                                   > "$MACHINE/.codex/sessions/2026-05-13.jsonl"
printf '<?xml version="1.0"?><plist></plist>'                      > "$MACHINE/.codex/themes/dark.tmTheme"
printf '%s' '{"token": "sk-canary-credential-BBBBBB"}'             > "$MACHINE/.claude/.credentials.json"
printf '%s' '{"local": true, "secret": "canary-CCCCCC"}'           > "$MACHINE/.claude/settings.local.json"
printf '%s' '{"id": "abc", "secret": "canary-DDDDDD"}'             > "$MACHINE/.claude/statsig/state.json"
printf 'Local notes; should not sync. Marker: canary-EEEEEE\n'     > "$MACHINE/NOTES.local.md"
printf 'Marker: canary-FFFFFF-bak\n'                               > "$MACHINE/.claude/stale-copy.bak"
printf 'Marker: canary-GGGGGG-tilde\n'                             > "$MACHINE/.claude/editor-temp.md~"

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
