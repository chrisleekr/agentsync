#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Scenario 5 — `agentsync key rotate` replaces the active recipient. After
# rotation every blob in the vault decrypts under the new key and the old
# key no longer works. Pre-rotation plaintext must equal post-rotation
# plaintext for every blob (the rotation is a re-encryption, not a content
# change).

VAULT_PATH=/vault/rotate.git
VAULT_URL_R="file://${VAULT_PATH}"
MACHINE=/tmp/rotate
KEY="$MACHINE/.config/agentsync/key.txt"

cd /app
fresh_bare_vault "$VAULT_PATH"
rm -rf "$MACHINE"
mkdir -p "$MACHINE"
rsync -a --exclude='*.bak' --exclude='*~' /home/agent/fixtures/home/ "$MACHINE/"

step "Init + push baseline state"
with_machine "$MACHINE" bun run src/cli.ts init --remote "$VAULT_URL_R" --branch main
with_machine "$MACHINE" bun run src/cli.ts push --message "rotate baseline"

step "Capture pre-rotation plaintext for every vault blob"
mkdir -p /tmp/rotate-pre
pre_blobs=$(git --git-dir="$VAULT_PATH" ls-tree -r HEAD | awk '$4 ~ /\.age$/ {print $4}')
while IFS= read -r path; do
  [ -z "$path" ] && continue
  safe=$(printf '%s' "$path" | tr '/' '_')
  git --git-dir="$VAULT_PATH" show "HEAD:${path}" | age -d -i "$KEY" \
    > "/tmp/rotate-pre/${safe}" 2>/dev/null
done <<<"$pre_blobs"
[ "$(ls -1 /tmp/rotate-pre | wc -l)" -gt 0 ] || fail "no pre-rotation plaintext captured"
pass "captured plaintext for $(ls -1 /tmp/rotate-pre | wc -l) blobs"

step "Backup old key, rotate"
cp "$KEY" /tmp/rotate-old.key
with_machine "$MACHINE" bun run src/cli.ts key rotate

step "Old key no longer decrypts a sample post-rotation blob"
sample=$(echo "$pre_blobs" | head -1)
if git --git-dir="$VAULT_PATH" show "HEAD:${sample}" | age -d -i /tmp/rotate-old.key 2>/dev/null >/dev/null; then
  fail "old key still decrypts $sample after rotation"
fi
pass "old key rejected on $sample"

step "New key decrypts every blob; plaintext byte-equal to pre-rotation"
post_blobs=$(git --git-dir="$VAULT_PATH" ls-tree -r HEAD | awk '$4 ~ /\.age$/ {print $4}')
while IFS= read -r path; do
  [ -z "$path" ] && continue
  safe=$(printf '%s' "$path" | tr '/' '_')
  post=$(git --git-dir="$VAULT_PATH" show "HEAD:${path}" | age -d -i "$KEY" 2>/dev/null)
  pre=$(cat "/tmp/rotate-pre/${safe}" 2>/dev/null || echo "MISSING")
  if [ "$pre" != "$post" ]; then
    fail "plaintext drift on $path after rotation"
  fi
done <<<"$post_blobs"
pass "every blob decrypts under new key with identical plaintext"

banner "KEY ROTATION"
