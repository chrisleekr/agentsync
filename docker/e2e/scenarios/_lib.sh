#!/usr/bin/env bash
# Shared assertion helpers for AgentSync E2E scenarios.
#
# Helpers are split into three layers:
#   1. Output & primitive assertions (step/pass/fail, assert_file_exists, etc.)
#   2. Vault-tree assertions (operate on the bare git repo behind the vault)
#   3. Scenario fixtures (with_machine, plant_fixture, daemon_ipc, etc.)
#
# Scenarios assume:
#   - /app holds the agentsync source (Bun project root)
#   - /vault holds at least one bare git repo (multi-machine scenarios create
#     additional bare repos under /vault/*.git as needed)
#   - The key file used to decrypt blobs in audit helpers is the agentsync key
#     at $HOME/.config/agentsync/key.txt for the active HOME.
#
# Every helper that mutates state echoes a step/pass line so logs read top-to-
# bottom on failure without cross-referencing line numbers.

# shellcheck disable=SC2034   # color/format helpers consumed by scenarios

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
blue()   { printf '\033[34m%s\033[0m\n' "$*"; }

step() { yellow "▶ $*"; }
pass() { green  "  ✓ $*"; }
fail() { red    "  ✗ $*"; exit 1; }
info() { blue   "  · $*"; }

banner() {
  green ""
  green "════════════════════════════════════════"
  green "  ✓✓✓ $* PASSED"
  green "════════════════════════════════════════"
}

# ─── Layer 1: primitive assertions ───────────────────────────────────────────

assert_file_exists() {
  [ -f "$1" ] || fail "expected file missing: $1"
  pass "file exists: $1"
}

assert_file_absent() {
  [ ! -e "$1" ] || fail "expected absent: $1"
  pass "absent: $1"
}

assert_dir_exists() {
  [ -d "$1" ] || fail "expected dir missing: $1"
  pass "dir exists: $1"
}

assert_contains() {
  local file="$1" needle="$2"
  grep -qF "$needle" "$file" || fail "expected '$needle' in $file"
  pass "contains '$needle': $file"
}

assert_not_contains() {
  local file="$1" needle="$2"
  if grep -qF "$needle" "$file"; then
    fail "did NOT expect '$needle' in $file"
  fi
  pass "absent '$needle': $file"
}

# ─── Layer 2: vault-tree assertions ──────────────────────────────────────────

# assert_in_vault <vault-git-dir> <substring>
# Asserts at least one path in HEAD's tree contains the substring.
assert_in_vault() {
  local vault="$1" needle="$2"
  git --git-dir="$vault" ls-tree -r HEAD | awk '{print $4}' | grep -qF "$needle" \
    || fail "vault $vault has no entry matching '$needle'"
  pass "vault contains: $needle"
}

# assert_not_in_vault <vault-git-dir> <substring>
assert_not_in_vault() {
  local vault="$1" needle="$2"
  if git --git-dir="$vault" ls-tree -r HEAD | awk '{print $4}' | grep -qF "$needle"; then
    fail "vault $vault unexpectedly contains '$needle'"
  fi
  pass "vault absent: $needle"
}

# assert_no_literal_in_vault <vault-git-dir> <key-file> <regex>
# Decrypts every .age blob with the given key file and greps each plaintext
# against the regex. Any match fails the scenario. Used to catch issue #47
# regressions where literal secrets travel through the encrypted artifact body.
#
# Plaintext lands on disk (not in shell vars) so binary payloads with NUL
# bytes are preserved. Decrypt failures abort the audit — a swallowed
# decrypt error would silently under-count leaks.
assert_no_literal_in_vault() {
  local vault="$1" key_file="$2" regex="$3"
  [ -f "$key_file" ] || fail "key file missing: $key_file"
  local blobs
  blobs=$(git --git-dir="$vault" ls-tree -r HEAD | awk '$4 ~ /\.age$/ {print $4}')
  local hit="" tmp
  tmp=$(mktemp)
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    if ! git --git-dir="$vault" show "HEAD:${path}" | age -d -i "$key_file" > "$tmp" 2>/dev/null; then
      rm -f "$tmp"
      fail "could not decrypt $path (key mismatch or corrupt blob)"
    fi
    if grep -Eq "$regex" "$tmp"; then
      hit="${hit}${path} "
    fi
  done <<<"$blobs"
  rm -f "$tmp"
  if [ -n "$hit" ]; then
    fail "literal regex '$regex' found inside vault blobs: $hit"
  fi
  pass "no plaintext match for '$regex' across vault"
}

# tar_age_extract <vault-git-dir> <vault-path> <out-dir> <key-file>
# Decrypts a tar.age skill bundle and extracts it. <vault-path> is the path
# inside the bare git tree (e.g. "claude/skills/postgres-helper.tar.age").
tar_age_extract() {
  local vault="$1" vault_path="$2" out_dir="$3" key_file="$4"
  mkdir -p "$out_dir"
  # Skill artifact pipeline (see src/agents/skills-walker.ts:256):
  #   disk → archiveDirectory (tar.gz buffer) → base64 string → encryptString
  # On extract: age-decrypt → base64 decode → tar -xz.
  git --git-dir="$vault" show "HEAD:${vault_path}" \
    | age -d -i "$key_file" \
    | base64 -d \
    | tar -xz -C "$out_dir"
}

# ─── Layer 3: machine + daemon helpers ───────────────────────────────────────

# with_machine <home-dir> <cmd...>
# Runs cmd from /app with HOME pointed at <home-dir>. Used by multi-machine
# scenarios so cli.ts captures the right paths via paths.ts per invocation.
with_machine() {
  local home="$1"; shift
  ( cd /app && HOME="$home" "$@" )
}

# plant_fixture <fixtures-relpath> <machine-home>
# Copies a file from the fixtures tree into the machine's HOME, preserving the
# relative path under the source root.
plant_fixture() {
  local rel="$1" home="$2"
  local src="/home/agent/fixtures/${rel}"
  local dst="${home}/${rel#home/}"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
}

# assert_field_eq <fileA> <fileB> <jq-path>
# Compares a jq path across two JSON files. For TOML files, point at the
# already-rendered intermediate JSON (callers use bun -e to convert).
assert_field_eq() {
  local a="$1" b="$2" path="$3"
  local va vb
  va=$(jq -c "$path" <"$a")
  vb=$(jq -c "$path" <"$b")
  if [ "$va" = "$vb" ]; then
    pass "field $path matches: $va"
  else
    fail "field $path differs: A=$va B=$vb"
  fi
}

# assert_field_only <file> <jq-path> <expected-value>
# Asserts the given jq path equals expected, and no sibling key was changed.
# Caller is responsible for picking a path narrow enough to be meaningful.
assert_field_only() {
  local file="$1" path="$2" expected="$3"
  local actual
  actual=$(jq -c "$path" <"$file")
  [ "$actual" = "$expected" ] \
    || fail "field $path expected $expected got $actual"
  pass "field $path = $expected (no sibling drift checked separately)"
}

# assert_path_rewritten <file> <jq-path> <expected-prefix>
# For scenario 20 (HOME portability). Asserts the jq-path value starts with
# the expected prefix (e.g. /home/beta after pulling on machine B).
assert_path_rewritten() {
  local file="$1" path="$2" prefix="$3"
  local actual
  actual=$(jq -r "$path" <"$file")
  case "$actual" in
    "$prefix"*) pass "$path rewritten to ${prefix}…" ;;
    *)          fail "$path expected prefix $prefix, got: $actual" ;;
  esac
}

# assert_round_trip <machine-a-home> <machine-b-home> <relpath>
# Byte-equal compare of a whole file across two machine homes after a vault
# round-trip. Markdown and other wholesale-synced files use this.
assert_round_trip() {
  local a="$1" b="$2" rel="$3"
  if diff -q "${a}/${rel}" "${b}/${rel}" >/dev/null; then
    pass "round-trip byte-equal: $rel"
  else
    fail "round-trip differs: $rel"
    diff "${a}/${rel}" "${b}/${rel}" | head -20 || true
  fi
}

# wait_for_commit <vault-git-dir> <timeout-sec>
# Polls vault HEAD until a NEW commit lands (relative to call-time HEAD) or
# the timeout expires.
wait_for_commit() {
  local vault="$1" timeout="$2"
  local start_head end_head
  start_head=$(git --git-dir="$vault" rev-parse HEAD 2>/dev/null || echo "EMPTY")
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    end_head=$(git --git-dir="$vault" rev-parse HEAD 2>/dev/null || echo "EMPTY")
    if [ "$end_head" != "$start_head" ]; then
      pass "vault advanced: $start_head → $end_head"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  fail "vault HEAD unchanged after ${timeout}s"
}

# fresh_bare_vault <path>
# Re-creates a bare repo at <path>, used by multi-machine and protocol
# scenarios that need an isolated vault.
fresh_bare_vault() {
  local path="$1"
  rm -rf "$path"
  git init --bare "$path" >/dev/null
  git -C "$path" symbolic-ref HEAD refs/heads/main
  pass "fresh bare vault at $path"
}
