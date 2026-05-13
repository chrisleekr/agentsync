#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# --agent X must scope push/pull to a single adapter so users can recover one
# tool without dragging others. --dry-run on pull must report would-apply set
# without writing anything.

VAULT_PATH=/vault/agent-filter.git
VAULT_URL="file://${VAULT_PATH}"

# Adapters to test in isolation. Each adapter writes blobs under "<name>/" in
# the vault tree; this prefix is the scoping signal.
ADAPTERS=(claude codex cursor copilot vscode)

# Plant the full fixture set on a fresh A so every adapter has source state.
plant_full_a() {
  local home="$1"
  rm -rf "$home"
  mkdir -p "$home"
  plant_fixture home/.claude/CLAUDE.md                            "$home"
  plant_fixture home/.claude/settings.json                        "$home"
  plant_fixture home/.claude.json                                 "$home"
  plant_fixture home/.codex/AGENTS.md                             "$home"
  plant_fixture home/.codex/config.toml                           "$home"
  plant_fixture home/.cursor/mcp.json                             "$home"
  plant_fixture home/.config/Cursor/User/settings.json            "$home"
  plant_fixture home/.copilot/copilot-instructions.md             "$home"
  plant_fixture home/.config/Code/User/settings.json              "$home"
  plant_fixture home/.config/Code/User/mcp.json                   "$home"
}

for X in "${ADAPTERS[@]}"; do
  step "── Subtest: --agent ${X} ────────────────────────────"
  fresh_bare_vault "$VAULT_PATH"
  A="/tmp/agent-filter-${X}-a"
  B="/tmp/agent-filter-${X}-b"

  plant_full_a "$A"
  with_machine "$A" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
  with_machine "$A" bun run src/cli.ts push --agent "$X" --message "scope push to ${X}"

  step "Vault has ${X}/ entries"
  assert_in_vault "$VAULT_PATH" "${X}/"

  step "Vault has NO entries from other adapters"
  for OTHER in "${ADAPTERS[@]}"; do
    [ "$OTHER" = "$X" ] && continue
    assert_not_in_vault "$VAULT_PATH" "${OTHER}/"
  done

  step "Machine B: pull --agent ${X}"
  rm -rf "$B"
  mkdir -p "$B/.config/agentsync"
  cp "$A/.config/agentsync/key.txt" "$B/.config/agentsync/key.txt"
  chmod 600 "$B/.config/agentsync/key.txt"
  with_machine "$B" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
  with_machine "$B" bun run src/cli.ts pull --agent "$X"

  step "Machine B has ${X} home, no other adapter homes restored"
  case "$X" in
    claude)   assert_dir_exists "$B/.claude" ;;
    codex)    assert_dir_exists "$B/.codex" ;;
    cursor)
      # Cursor restores either ~/.cursor (mcp) or ~/.config/Cursor (rules).
      [ -d "$B/.cursor" ] || [ -d "$B/.config/Cursor" ] \
        || fail "cursor pull produced neither ~/.cursor nor ~/.config/Cursor"
      pass "cursor adapter restored on B"
      ;;
    copilot)  assert_dir_exists "$B/.copilot" ;;
    vscode)
      [ -d "$B/.config/Code" ] || fail "vscode pull missing ~/.config/Code"
      pass "vscode adapter restored on B"
      ;;
  esac

  for OTHER in "${ADAPTERS[@]}"; do
    [ "$OTHER" = "$X" ] && continue
    case "$OTHER" in
      claude)   [ ! -e "$B/.claude/CLAUDE.md" ]                   || fail "leaked claude state to B on --agent $X" ;;
      codex)    [ ! -e "$B/.codex/AGENTS.md" ]                    || fail "leaked codex state to B on --agent $X" ;;
      cursor)   [ ! -e "$B/.cursor/mcp.json" ] \
                  && [ ! -e "$B/.config/Cursor/User/settings.json" ] \
                  || fail "leaked cursor state to B on --agent $X" ;;
      copilot)  [ ! -e "$B/.copilot/copilot-instructions.md" ]    || fail "leaked copilot state to B on --agent $X" ;;
      vscode)   [ ! -e "$B/.config/Code/User/mcp.json" ]          || fail "leaked vscode state to B on --agent $X" ;;
    esac
  done
  pass "no other-adapter leakage on B for --agent ${X}"
done

# ── Final subtest: pull --dry-run ────────────────────────────────────────────
step "── Subtest: pull --dry-run writes nothing ───────────────"
fresh_bare_vault "$VAULT_PATH"
A="/tmp/agent-filter-dry-a"
B="/tmp/agent-filter-dry-b"
plant_full_a "$A"
with_machine "$A" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
with_machine "$A" bun run src/cli.ts push --message "full snapshot for dry-run"

rm -rf "$B"
mkdir -p "$B/.config/agentsync"
cp "$A/.config/agentsync/key.txt" "$B/.config/agentsync/key.txt"
chmod 600 "$B/.config/agentsync/key.txt"
with_machine "$B" bun run src/cli.ts init --remote "$VAULT_URL" --branch main

# Snapshot the B tree (minus the agentsync vault clone + key) and compare
# after dry-run. Include directories alongside files so a `pull --dry-run`
# that creates or removes an empty directory is still caught.
pre_snapshot=$(mktemp)
( cd "$B" && find . -path './.config/agentsync' -prune -o -print | sort ) > "$pre_snapshot"

with_machine "$B" bun run src/cli.ts pull --dry-run 2>&1 | tee /tmp/agent-filter-dryrun.log

post_snapshot=$(mktemp)
( cd "$B" && find . -path './.config/agentsync' -prune -o -print | sort ) > "$post_snapshot"

diff -q "$pre_snapshot" "$post_snapshot" \
  || fail "pull --dry-run created or removed files in B's tree"
pass "pull --dry-run produced zero filesystem mutations under B"
rm -f "$pre_snapshot" "$post_snapshot"

banner "AGENT FILTER + DRY-RUN"
