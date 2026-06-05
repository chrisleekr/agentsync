#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Validate `push --dry-run`: the dry-run reports the change-set on stdout but
# leaves the vault HEAD unchanged. A subsequent real push must then commit the
# same mutation. push.ts emits one `log.info` line per artifact in the form:
#   [dry-run] [<agent>] <sourcePath> → <targetPath>
# Both sourcePath and targetPath are present in stdout, so the mutated file's
# path is the search anchor below.

VAULT_PATH=/vault/dryrun.git
VAULT_URL="file://${VAULT_PATH}"
MACHINE=/tmp/dryrun-machine

step "Plant fresh bare vault + minimal claude fixture"
fresh_bare_vault "$VAULT_PATH"
rm -rf "$MACHINE"
mkdir -p "$MACHINE/.claude"
echo "# baseline CLAUDE.md from dry-run scenario" > "$MACHINE/.claude/CLAUDE.md"

step "init + initial push so vault has a baseline commit"
cd /app
HOME="$MACHINE" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
HOME="$MACHINE" bun run src/cli.ts push --message "dry-run scenario baseline"

pre_head=$(git --git-dir="$VAULT_PATH" rev-parse HEAD)
pass "pre-mutation vault HEAD = ${pre_head:0:10}"

step "Mutate CLAUDE.md so the next push has something to report"
echo "## new section added between snapshots" >> "$MACHINE/.claude/CLAUDE.md"

step "Run push --dry-run — exit 0, stdout lists the mutated artifact"
set +e
dryrun_out=$(HOME="$MACHINE" bun run src/cli.ts push --dry-run 2>&1)
dryrun_exit=$?
set -e
echo "$dryrun_out" | sed 's/^/    /'
[ "$dryrun_exit" -eq 0 ] || fail "push --dry-run exit=$dryrun_exit (expected 0)"
pass "dry-run exit=0"

step "CRITICAL: stdout names the [claude] adapter + CLAUDE.md path"
echo "$dryrun_out" | grep -qF "[dry-run]" \
  || fail "stdout missing [dry-run] marker"
echo "$dryrun_out" | grep -qF "[claude]" \
  || fail "stdout doesn't attribute mutation to claude adapter"
echo "$dryrun_out" | grep -qF "CLAUDE.md" \
  || fail "stdout doesn't reference the mutated CLAUDE.md path"
pass "stdout enumerates the mutated artifact"

step "CRITICAL: vault HEAD unchanged after dry-run"
post_dryrun_head=$(git --git-dir="$VAULT_PATH" rev-parse HEAD)
[ "$pre_head" = "$post_dryrun_head" ] \
  || fail "vault HEAD advanced ${pre_head:0:10} → ${post_dryrun_head:0:10} during dry-run"
pass "vault HEAD intact at ${post_dryrun_head:0:10}"

step "CRITICAL: vault HEAD blob does NOT contain the new mutation marker"
# Decrypt the current vault CLAUDE.md.age and assert the new section is
# absent — proves dry-run wrote nothing through the encryptor either.
plaintext=$(vshow "$VAULT_PATH" "claude/CLAUDE.md.age" \
            | age -d -i "$MACHINE/.config/agentsync/key.txt")
if echo "$plaintext" | grep -qF "new section added between snapshots"; then
  fail "dry-run leaked the new content into the vault blob"
fi
pass "vault blob still holds the baseline plaintext"

step "Now run a real push — vault MUST advance and contain the mutation"
HOME="$MACHINE" bun run src/cli.ts push --message "real push after dry-run"
post_real_head=$(git --git-dir="$VAULT_PATH" rev-parse HEAD)
[ "$pre_head" != "$post_real_head" ] \
  || fail "real push didn't advance vault HEAD"
new_plaintext=$(vshow "$VAULT_PATH" "claude/CLAUDE.md.age" \
                | age -d -i "$MACHINE/.config/agentsync/key.txt")
echo "$new_plaintext" | grep -qF "new section added between snapshots" \
  || fail "real push didn't write the mutated content"
pass "real push committed ${pre_head:0:10} → ${post_real_head:0:10}"

banner "DRY-RUN"

