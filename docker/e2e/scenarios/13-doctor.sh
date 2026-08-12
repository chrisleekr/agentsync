#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Exercise every check src/commands/doctor.ts emits. The source enumerates:
#   1. Private key permissions / Private key
#   2. age-encryption module
#   3. Claude settings.json
#   3a. Claude/Codex/Cursor skills directory (Copilot intentionally omitted)
#   4. agentsync.toml schema
#   5. Git remote reachable
#   6. Credential files in vault
#   7. Legacy daemon leftovers
# console.table prints rows with name/status/detail columns — we grep for the
# stable `name` strings and the `pass|warn|fail` status word on the same row.

VAULT_PATH=/vault/doctor.git
VAULT_URL="file://${VAULT_PATH}"
MACHINE=/tmp/doctor-machine
CFG_DIR="$MACHINE/.config/agentsync"
KEY_FILE="$CFG_DIR/key.txt"

step "Plant fresh bare vault + machine HOME with full fixture tree"
fresh_bare_vault "$VAULT_PATH"
rm -rf "$MACHINE"
mkdir -p "$MACHINE"
# Rehydrate fixture into the scenario-local HOME so dependent doctor checks
# (Claude settings.json, skills directories) have real state to inspect.
rsync -a --exclude='*.bak' --exclude='*~' /home/agent/fixtures/home/ "$MACHINE/"

step "init + push so vault has a parseable agentsync.toml + reachable remote"
cd /app
HOME="$MACHINE" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
HOME="$MACHINE" bun run src/cli.ts push --message "doctor scenario seed"

# ─── Positive run: every check should pass or warn-but-not-fail ──────────────

step "Run agentsync doctor on the healthy machine"
set +e
out=$(HOME="$MACHINE" bun run src/cli.ts doctor 2>&1)
exit_code=$?
set -e
echo "$out" | sed 's/^/    /'
[ "$exit_code" -eq 0 ] || fail "doctor exited $exit_code on healthy machine (expected 0)"
pass "doctor exit=0"

step "CRITICAL: every check name from doctor.ts appears in output"
for name in \
  "Private key permissions" \
  "age-encryption module" \
  "Claude settings.json" \
  "Claude skills directory" \
  "Codex skills directory" \
  "Cursor skills directory" \
  "agentsync.toml schema" \
  "Git remote reachable" \
  "Credential files in vault" \
  "Legacy daemon leftovers" ; do
  echo "$out" | grep -qF "$name" || fail "missing check row: $name"
done
pass "all enumerated check rows present"

step "CRITICAL: console.table emits at least one 'pass' status (healthy baseline)"
echo "$out" | grep -qE "'pass'|\"pass\"|│ pass" \
  || fail "no pass status row found in doctor output"
pass "at least one 'pass' status present"

# Doctor warns (does not fail) when the git remote is a file:// URL the CLI
# can ls-remote — exit 0 path. Schema, key permissions, age module, and
# settings.json are all healthy here so this is the cleanest baseline.

# ─── Negative test 1: chmod the private key to 644 ───────────────────────────

step "Break check #1: chmod key.txt to 644"
chmod 644 "$KEY_FILE"
set +e
bad_out=$(HOME="$MACHINE" bun run src/cli.ts doctor 2>&1)
bad_exit=$?
set -e
echo "$bad_out" | sed 's/^/    /'
# Permission issue is a warn (not fail) per doctor.ts, so exit stays 0.
[ "$bad_exit" -eq 0 ] || fail "doctor exit=$bad_exit (expected 0; perms is a warn)"
echo "$bad_out" | grep -qF "Private key permissions" \
  || fail "missing 'Private key permissions' row after chmod 644"
echo "$bad_out" | grep -qE "Expected 600, got 644|got 644" \
  || fail "warn detail does not mention the 644 mode"
pass "doctor surfaces the 644 permission issue"

step "Restore 600 on key.txt"
chmod 600 "$KEY_FILE"

# ─── Negative test 2: delete the vault config ────────────────────────────────

step "Break check #4: remove agentsync.toml from the vault"
mv "$MACHINE/.config/agentsync/vault/agentsync.toml" \
   "$MACHINE/.config/agentsync/vault/agentsync.toml.bak"
set +e
missing_out=$(HOME="$MACHINE" bun run src/cli.ts doctor 2>&1)
missing_exit=$?
set -e
echo "$missing_out" | sed 's/^/    /'
# Schema parse failure is `fail` status — doctor exit goes to 1.
[ "$missing_exit" -eq 1 ] || fail "doctor exit=$missing_exit (expected 1; missing config is fail)"
echo "$missing_out" | grep -qF "agentsync.toml schema" \
  || fail "missing 'agentsync.toml schema' row after deleting config"
pass "doctor reports schema failure + exits 1"
mv "$MACHINE/.config/agentsync/vault/agentsync.toml.bak" \
   "$MACHINE/.config/agentsync/vault/agentsync.toml"

# ─── Negative test 3: corrupt the Claude settings.json path ──────────────────

step "Break check #3: remove ~/.claude/settings.json"
mv "$MACHINE/.claude/settings.json" "$MACHINE/.claude/settings.json.bak"
set +e
nosettings_out=$(HOME="$MACHINE" bun run src/cli.ts doctor 2>&1)
nosettings_exit=$?
set -e
echo "$nosettings_out" | sed 's/^/    /'
# Missing Claude settings is `warn` per doctor.ts — exit stays 0.
[ "$nosettings_exit" -eq 0 ] || fail "doctor exit=$nosettings_exit (expected 0; missing settings is warn)"
echo "$nosettings_out" | grep -qF "Claude settings.json" \
  || fail "missing 'Claude settings.json' row"
echo "$nosettings_out" | grep -qE "Not found or unreadable|partial" \
  || fail "warn detail does not flag the missing settings.json"
pass "doctor reports missing Claude settings.json as warn"
mv "$MACHINE/.claude/settings.json.bak" "$MACHINE/.claude/settings.json"

# ─── Negative test 4: legacy Linux unit + custom-home socket ────────────────

step "Plant a legacy systemd user unit and stale socket under AGENTSYNC_DIR"
LEGACY_UNIT="$MACHINE/.config/systemd/user/agentsync.service"
CUSTOM_AGENTSYNC_DIR="$MACHINE/custom-agentsync"
STALE_SOCKET="$CUSTOM_AGENTSYNC_DIR/daemon.sock"
mkdir -p "$(dirname "$LEGACY_UNIT")" "$CUSTOM_AGENTSYNC_DIR"
printf '%s\n' "legacy user unit sentinel" > "$LEGACY_UNIT"
printf '%s\n' "legacy socket sentinel" > "$STALE_SOCKET"

set +e
legacy_out=$(HOME="$MACHINE" \
  AGENTSYNC_DIR="$CUSTOM_AGENTSYNC_DIR" \
  AGENTSYNC_KEY_PATH="$KEY_FILE" \
  AGENTSYNC_VAULT_DIR="$CFG_DIR/vault" \
  bun run src/cli.ts doctor 2>&1)
legacy_exit=$?
set -e
echo "$legacy_out" | sed 's/^/    /'
[ "$legacy_exit" -eq 0 ] \
  || fail "doctor exit=$legacy_exit (expected 0; legacy leftovers are a warn)"
echo "$legacy_out" | grep -qF "Legacy daemon leftovers" \
  || fail "missing 'Legacy daemon leftovers' row"
echo "$legacy_out" | grep -qF \
  "systemctl --user disable --now agentsync; rm -- '$LEGACY_UNIT'; systemctl --user daemon-reload" \
  || fail "warning does not contain exact systemd removal guidance"
echo "$legacy_out" | grep -qF "Stale IPC socket $STALE_SOCKET — remove with: rm -- '$STALE_SOCKET'" \
  || fail "warning does not contain exact custom-home socket removal guidance"
[ "$(cat "$LEGACY_UNIT")" = "legacy user unit sentinel" ] \
  || fail "doctor mutated the legacy systemd unit"
[ "$(cat "$STALE_SOCKET")" = "legacy socket sentinel" ] \
  || fail "doctor mutated the stale socket"
pass "doctor warns with exact cleanup guidance, exits 0, and does not mutate leftovers"

# TODO: not exercised — Credential files in vault (fail path). Would require
# planting an unencrypted credentials/.env file directly inside the vault dir,
# which is not a real-world failure mode for AgentSync's own code path
# (push.ts only writes .age files). Positive `pass` row is asserted above.

banner "DOCTOR"
