#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

step "Verify bootstrap populated agent config dirs"
assert_dir_exists  "$HOME/.claude"
assert_file_exists "$HOME/.claude/settings.json"
assert_dir_exists  "$HOME/.codex"
assert_dir_exists  "$HOME/.cursor"
assert_file_exists "$HOME/.config/Code/User/settings.json"
assert_file_exists "$HOME/.config/Cursor/User/settings.json"

step "Run agentsync init against file:// vault (init also performs first push)"
cd /app
bun run src/cli.ts init --remote "${VAULT_URL}" --branch main

step "Verify init wrote keypair and vault config"
assert_file_exists "$HOME/.config/agentsync/key.txt"
assert_file_exists "$HOME/.config/agentsync/vault/agentsync.toml"
assert_contains    "$HOME/.config/agentsync/vault/agentsync.toml" "${VAULT_URL}"

step "Verify vault remote received the init commit"
git --git-dir=/vault/repo.git log --oneline | tee /tmp/vault-log.txt
[ -s /tmp/vault-log.txt ] || fail "vault has no commits after init"
pass "vault has commits"

step "Run agentsync push (snapshot encrypted agent state)"
bun run src/cli.ts push --message "smoke: encrypted snapshot"

step "Verify vault now contains .age artifacts"
artifact_count=$(git --git-dir=/vault/repo.git ls-tree -r HEAD | grep -c '\.age$' || true)
[ "$artifact_count" -gt 0 ] || fail "vault contains no .age artifacts after push"
pass "vault contains $artifact_count encrypted artifacts"

step "Mutate a synced file and push again (incremental commit path)"
echo '{"rules": "updated rule from smoke test"}' > "$HOME/.config/Cursor/User/settings.json"
bun run src/cli.ts push --message "smoke: incremental update"
new_count=$(git --git-dir=/vault/repo.git log --oneline | wc -l | tr -d ' ')
[ "$new_count" -ge 2 ] || fail "expected ≥2 commits, got $new_count"
pass "vault now has $new_count commits"

step "Run agentsync status"
bun run src/cli.ts status

step "CRITICAL: never-sync paths must NOT appear in vault tree"
# Codex's bootstrap created ~/.codex/auth.json with a stub credential.
# Claude's never-sync list also includes .credentials.json.
# Vault must not contain ANY of these under any path or .age suffix.
vault_files=$(git --git-dir=/vault/repo.git ls-tree -r HEAD | awk '{print $4}')
echo "$vault_files" | sed 's/^/    /'
forbidden=$(echo "$vault_files" | grep -E '(^|/)(auth\.json|\.credentials\.json|key\.txt)(\.age)?$' || true)
if [ -n "$forbidden" ]; then
  fail "credential file leaked into vault: $forbidden"
fi
pass "no credential files in vault tree"

step "CRITICAL: vault artifacts must be age-encrypted (not plaintext)"
# AgentSync emits ASCII-armored age, which begins with the PEM-style header.
# Binary age would start with "age-encryption.org" — accept either form.
sample_artifact=$(echo "$vault_files" | grep '\.age$' | head -1)
[ -n "$sample_artifact" ] || fail "no .age artifact to verify"
header=$(git --git-dir=/vault/repo.git show "HEAD:${sample_artifact}" | head -1)
case "$header" in
  *"age-encryption.org"*|*"BEGIN AGE ENCRYPTED FILE"*)
    pass "artifact $sample_artifact is age-encrypted (header: $header)" ;;
  *)
    fail "artifact $sample_artifact is NOT age-encrypted (header: $header)" ;;
esac

step "CRITICAL: vault must NOT contain plaintext of the stub credential"
# Walk every blob in the vault and grep for the stub key. Even one match = leak.
stub_key="${OPENAI_API_KEY:-sk-stub-for-bootstrap}"
leak=$(git --git-dir=/vault/repo.git rev-list --objects --all | awk '{print $1}' | sort -u | \
       while read sha; do
         git --git-dir=/vault/repo.git cat-file -p "$sha" 2>/dev/null | grep -lF "$stub_key" && echo "LEAK_IN:$sha"
       done | grep '^LEAK_IN:' || true)
if [ -n "$leak" ]; then
  fail "stub credential '$stub_key' found plaintext in vault: $leak"
fi
pass "stub credential absent from every vault blob"

green ""
green "════════════════════════════════════════"
green "  ✓✓✓ SMOKE + CRITICAL-PATH SCENARIO PASSED"
green "════════════════════════════════════════"
