#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Scenario 1 (smoke) — single-machine init+push proves the full fixture
# survives a round through the encrypted vault, every adapter contributed
# at least one artifact, and no credential canary leaked.

step "Verify entrypoint installed the complete real-customer fixture"
assert_dir_exists  "$HOME/.claude"
assert_file_exists "$HOME/.claude/CLAUDE.md"
assert_file_exists "$HOME/.claude/settings.json"
assert_file_exists "$HOME/.claude.json"
assert_file_exists "$HOME/.claude/rules/coding-style.md"
assert_dir_exists  "$HOME/.claude/skills/postgres-helper"
assert_file_exists "$HOME/.codex/AGENTS.md"
assert_file_exists "$HOME/.codex/AGENTS.override.md"
assert_file_exists "$HOME/.codex/config.toml"
assert_file_exists "$HOME/.agents/skills/sql-formatter/SKILL.md"
assert_file_exists "$HOME/.cursor/mcp.json"
assert_file_exists "$HOME/.config/Code/User/mcp.json"
assert_file_exists "$HOME/.config/Cursor/User/settings.json"
assert_file_exists "$HOME/.copilot/copilot-instructions.md"
assert_file_exists "$HOME/.copilot/agents/bug-triager.agent.md"

step "agentsync init"
cd /app
bun run src/cli.ts init --remote "${VAULT_URL}" --branch main
assert_file_exists "$HOME/.config/agentsync/key.txt"
assert_file_exists "$HOME/.config/agentsync/vault/agentsync.toml"
assert_contains    "$HOME/.config/agentsync/vault/agentsync.toml" "${VAULT_URL}"

step "Enable vscode adapter (off by default per schema) so mcp.json is exercised"
sed -i 's/^vscode = false$/vscode = true/' "$HOME/.config/agentsync/vault/agentsync.toml"
grep -qE '^vscode = true$' "$HOME/.config/agentsync/vault/agentsync.toml" \
  || fail "vscode toggle did not apply"

step "agentsync push"
bun run src/cli.ts push --message "smoke: encrypted snapshot"

step "Vault advanced (≥1 commit)"
git --git-dir=/vault/repo.git log --oneline | tee /tmp/vault-log.txt
[ -s /tmp/vault-log.txt ] || fail "vault has no commits after push"
pass "vault has commits"

step "Vault contains ≥1 artifact for every adapter the fixture populated"
assert_in_vault /vault/repo.git "claude/"
assert_in_vault /vault/repo.git "codex/"
assert_in_vault /vault/repo.git "cursor/"
assert_in_vault /vault/repo.git "vscode/"
assert_in_vault /vault/repo.git "copilot/"

step "Vault contains the specific adapter artifacts we care about"
# Claude — wholesale + subset
assert_in_vault /vault/repo.git "claude/CLAUDE.md.age"
assert_in_vault /vault/repo.git "claude/settings.json.age"
assert_in_vault /vault/repo.git "claude/claude.json.age"
assert_in_vault /vault/repo.git "claude/rules/coding-style.md.age"
assert_in_vault /vault/repo.git "claude/skills/postgres-helper.tar.age"
# Codex — AGENTS + override + config + skill at canonical user-scope path
assert_in_vault /vault/repo.git "codex/AGENTS.md.age"
assert_in_vault /vault/repo.git "codex/AGENTS.override.md.age"
assert_in_vault /vault/repo.git "codex/config.toml.age"
assert_in_vault /vault/repo.git "codex/skills/sql-formatter.tar.age"
# Cursor — MCP whole + rules subset
assert_in_vault /vault/repo.git "cursor/mcp.json.age"
# VS Code — MCP only (no settings/keybindings/snippets)
assert_in_vault /vault/repo.git "vscode/mcp.json.age"
assert_not_in_vault /vault/repo.git "vscode/settings.json"
assert_not_in_vault /vault/repo.git "vscode/keybindings.json"
assert_not_in_vault /vault/repo.git "vscode/snippets"
# Copilot — disk filename is `copilot-instructions.md` (B16); vault path is
# `copilot/instructions.md.age` (adapter strips the `copilot-` prefix to keep
# vault history stable). Single-file `<name>.agent.md` shape (B15).
assert_in_vault /vault/repo.git "copilot/instructions.md.age"
assert_in_vault /vault/repo.git "copilot/agents/bug-triager.agent.md.age"

step "agentsync status (sanity check; output is informational)"
bun run src/cli.ts status

step "CRITICAL: never-sync paths must NOT appear in vault tree"
vault_files=$(git --git-dir=/vault/repo.git ls-tree -r HEAD | awk '{print $4}')
forbidden=$(echo "$vault_files" | grep -E '(^|/)(auth\.json|\.credentials\.json|key\.txt|settings\.local\.json)(\.age)?$' || true)
if [ -n "$forbidden" ]; then
  fail "credential file leaked into vault: $forbidden"
fi
pass "no credential files in vault tree"

step "CRITICAL: vault artifacts are age-encrypted, not plaintext"
sample=$(echo "$vault_files" | grep '\.age$' | head -1)
[ -n "$sample" ] || fail "no .age artifact to verify"
header=$(git --git-dir=/vault/repo.git show "HEAD:${sample}" | head -1)
case "$header" in
  *"age-encryption.org"*|*"BEGIN AGE ENCRYPTED FILE"*)
    pass "artifact $sample is age-encrypted" ;;
  *)
    fail "artifact $sample is NOT age-encrypted (header: $header)" ;;
esac

step "CRITICAL: stub OPENAI_API_KEY must not appear plaintext in vault"
stub_key="${OPENAI_API_KEY:-sk-stub-for-bootstrap}"
leak=$(git --git-dir=/vault/repo.git rev-list --objects --all | awk '{print $1}' | sort -u | \
       while read -r sha; do
         git --git-dir=/vault/repo.git cat-file -p "$sha" 2>/dev/null | grep -lF "$stub_key" && echo "LEAK_IN:$sha"
       done | grep '^LEAK_IN:' || true)
if [ -n "$leak" ]; then
  fail "stub credential '$stub_key' found plaintext in vault: $leak"
fi
pass "stub credential absent from every vault blob"

banner "SMOKE + ADAPTER-COVERAGE"
