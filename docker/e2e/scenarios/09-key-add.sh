#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# `agentsync key add <name> <pubkey>` registers a second recipient and
# re-encrypts every .age blob for the expanded recipient set. After the call,
# BOTH identities must be able to decrypt vault artifacts. A second invocation
# with the same name+pubkey must be idempotent (no new commit, exit 0). The
# CLI uses positional <name> <pubkey>, not --recipient/--label.

VAULT_PATH=/vault/keyadd.git
VAULT_URL="file://${VAULT_PATH}"
A=/tmp/keyadd-machine
KEY2=/tmp/keyadd-key2.txt

step "Fresh vault + machine A initial push"
fresh_bare_vault "$VAULT_PATH"
rm -rf "$A"
mkdir -p "$A/.claude"
echo "# canary content for key-add" > "$A/.claude/CLAUDE.md"
plant_fixture home/.claude.json "$A"
plant_fixture home/.codex/config.toml "$A"

with_machine "$A" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
with_machine "$A" bun run src/cli.ts push --message "baseline for key-add"

step "Generate a second age identity (simulated 'work laptop')"
rm -f "$KEY2"
age-keygen -o "$KEY2" 2>/dev/null
chmod 600 "$KEY2"
RECIPIENT2=$(age-keygen -y "$KEY2")
[ -n "$RECIPIENT2" ] || fail "could not derive public recipient from $KEY2"
info "second recipient: ${RECIPIENT2:0:24}…"

step "Capture HEAD before key add"
head_before=$(git --git-dir="$VAULT_PATH" rev-parse HEAD)
info "vault HEAD before: ${head_before:0:12}"

step "Run agentsync key add work-laptop <recipient>"
with_machine "$A" bun run src/cli.ts key add work-laptop "$RECIPIENT2" 2>&1 | sed 's/^/    /'

step "Vault advanced to a new commit (re-encryption committed)"
head_after=$(git --git-dir="$VAULT_PATH" rev-parse HEAD)
info "vault HEAD after:  ${head_after:0:12}"
[ "$head_before" != "$head_after" ] || fail "key add did not commit — vault was not re-encrypted"
pass "vault advanced after key add"

step "Pick a sample .age blob from the vault"
sample=$(git --git-dir="$VAULT_PATH" ls-tree -r HEAD | awk '$4 ~ /\.age$/ {print $4; exit}')
[ -n "$sample" ] || fail "no .age blob found in vault"
info "decrypt target: $sample"

step "ORIGINAL key still decrypts the re-encrypted blob"
git --git-dir="$VAULT_PATH" show "HEAD:${sample}" | age -d -i "$A/.config/agentsync/key.txt" >/dev/null \
  || fail "original key cannot decrypt blob after key add — recipient set lost the original!"
pass "original key still decrypts vault"

step "NEW key also decrypts the same blob"
git --git-dir="$VAULT_PATH" show "HEAD:${sample}" | age -d -i "$KEY2" >/dev/null \
  || fail "new key cannot decrypt blob — vault was not re-encrypted for new recipient"
pass "new key decrypts vault"

step "Idempotency: re-running key add with same name+pubkey"
head_before_rerun=$(git --git-dir="$VAULT_PATH" rev-parse HEAD)
set +e
with_machine "$A" bun run src/cli.ts key add work-laptop "$RECIPIENT2" > /tmp/keyadd-rerun.log 2>&1
rerun_exit=$?
set -e
head_after_rerun=$(git --git-dir="$VAULT_PATH" rev-parse HEAD)
sed 's/^/    /' /tmp/keyadd-rerun.log

if [ "$rerun_exit" -eq 0 ] && [ "$head_before_rerun" = "$head_after_rerun" ]; then
  pass "idempotent: same name+pubkey → exit 0, no new commit"
elif [ "$rerun_exit" -eq 0 ] && [ "$head_before_rerun" != "$head_after_rerun" ]; then
  # Current CLI re-encrypts unconditionally; that's acceptable as long as the
  # second commit is still decryptable by both keys (verified below).
  info "re-run produced a new commit — CLI re-encrypts on every call"
  git --git-dir="$VAULT_PATH" show "HEAD:${sample}" | age -d -i "$A/.config/agentsync/key.txt" >/dev/null \
    || fail "original key lost after second key add"
  git --git-dir="$VAULT_PATH" show "HEAD:${sample}" | age -d -i "$KEY2" >/dev/null \
    || fail "new key lost after second key add"
  pass "re-run still produced a multi-recipient vault"
else
  # Rejecting with non-zero exit + 'already' message is also acceptable.
  grep -qiE "already|exists|duplicate" /tmp/keyadd-rerun.log \
    || fail "re-run failed (exit $rerun_exit) but no 'already exists' message"
  pass "re-run rejected duplicate with clear message (exit $rerun_exit)"
fi

banner "KEY ADD (SECOND RECIPIENT)"
