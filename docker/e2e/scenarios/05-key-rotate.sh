#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Verify `agentsync key rotate` truly re-encrypts the vault: the old age key
# must NO LONGER decrypt vault artifacts after rotation, and the new key MUST
# decrypt them. Without this, "rotate" is just renaming files.

VAULT_PATH=/vault/rotate.git
VAULT_URL="file://${VAULT_PATH}"
MACHINE=/tmp/rotate-machine
OLD_KEY_BACKUP=/tmp/rotate-old-key.txt

step "Initialize fresh bare vault for rotate scenario"
rm -rf "$MACHINE" "$VAULT_PATH"
git init --bare "$VAULT_PATH" >/dev/null
git -C "$VAULT_PATH" symbolic-ref HEAD refs/heads/main

step "Init machine + push initial state"
mkdir -p "$MACHINE/.claude"
echo "# pre-rotate canary content" > "$MACHINE/.claude/CLAUDE.md"
cd /app
HOME="$MACHINE" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
HOME="$MACHINE" bun run src/cli.ts push --message "pre-rotate snapshot"

step "Backup the pre-rotate age key (kept aside to prove rotation invalidates it)"
cp "$MACHINE/.config/agentsync/key.txt" "$OLD_KEY_BACKUP"
old_sha=$(sha256sum "$OLD_KEY_BACKUP" | awk '{print $1}')
pass "backed up old key (sha256: ${old_sha:0:16}…)"

step "Verify pre-rotate state: OLD key DOES decrypt vault"
encrypted_path="claude/CLAUDE.md.age"
git --git-dir="$VAULT_PATH" show "HEAD:${encrypted_path}" >/dev/null 2>&1 \
  || fail "vault missing $encrypted_path"
git --git-dir="$VAULT_PATH" show "HEAD:${encrypted_path}" | age -d -i "$OLD_KEY_BACKUP" >/dev/null \
  || fail "old key fails to decrypt BEFORE rotate — test setup broken"
pass "old key decrypts vault artifact (baseline)"

step "Run agentsync key rotate"
HOME="$MACHINE" bun run src/cli.ts key rotate 2>&1 | sed 's/^/    /'

step "CRITICAL: key.txt on disk is a NEW identity (different sha)"
new_sha=$(sha256sum "$MACHINE/.config/agentsync/key.txt" | awk '{print $1}')
[ "$old_sha" != "$new_sha" ] || fail "key.txt unchanged after rotate (sha matches backup)"
pass "key.txt rotated (new sha: ${new_sha:0:16}…)"

step "CRITICAL: OLD key no longer decrypts re-encrypted vault artifact"
git --git-dir="$VAULT_PATH" show "HEAD:${encrypted_path}" >/dev/null 2>&1 \
  || fail "vault missing $encrypted_path after rotate"
set +e
git --git-dir="$VAULT_PATH" show "HEAD:${encrypted_path}" | age -d -i "$OLD_KEY_BACKUP" >/dev/null 2>&1
old_decrypt_exit=$?
set -e
[ "$old_decrypt_exit" -ne 0 ] \
  || fail "OLD key STILL decrypts vault — rotate didn't actually re-encrypt!"
pass "OLD key correctly rejected by rotated vault (exit $old_decrypt_exit)"

step "CRITICAL: NEW key DOES decrypt the re-encrypted artifact"
plaintext=$(git --git-dir="$VAULT_PATH" show "HEAD:${encrypted_path}" | age -d -i "$MACHINE/.config/agentsync/key.txt") \
  || fail "new key cannot decrypt rotated vault — rotation broke decryption"
echo "$plaintext" | grep -qF "pre-rotate canary content" \
  || fail "decrypted content lacks original canary — rotation corrupted plaintext"
pass "new key decrypts vault, content preserved across rotation"

green ""
green "════════════════════════════════════════"
green "  ✓✓✓ KEY-ROTATE SCENARIO PASSED"
green "════════════════════════════════════════"
