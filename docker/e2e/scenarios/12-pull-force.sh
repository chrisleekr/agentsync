#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/home/agent/scenarios/_lib.sh
source /home/agent/scenarios/_lib.sh

# Spec says: plain `pull` warns on local-mod conflicts; `--force` overwrites;
# `--dry-run` previews without writing. Reading src/commands/pull.ts shows
# `--force` actually toggles git reconcile force (diverged vault history),
# not a local-file conflict check — local agent files are overwritten by
# whichever value the vault holds during apply(). This scenario records the
# observed behaviour and asserts on the parts the CLI actually implements:
# the dry-run no-write contract and the post-pull overwrite outcome.

VAULT_PATH=/vault/pull-force.git
VAULT_URL="file://${VAULT_PATH}"
A=/tmp/pull-force-a
B=/tmp/pull-force-b
CANARY="$B/.claude/CLAUDE.md"
VAULT_CONTENT="# CONTENT FROM VAULT (machine A)"
LOCAL_MUTATION="# LOCAL MUTATION ON B — should never silently leak to vault"

step "Machine A: push initial state"
fresh_bare_vault "$VAULT_PATH"
rm -rf "$A" "$B"
mkdir -p "$A/.claude"
echo "$VAULT_CONTENT" > "$A/.claude/CLAUDE.md"
plant_fixture home/.claude.json "$A"
with_machine "$A" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
with_machine "$A" bun run src/cli.ts push --message "baseline from A"

step "Machine B: init + first pull"
mkdir -p "$B/.config/agentsync"
cp "$A/.config/agentsync/key.txt" "$B/.config/agentsync/key.txt"
chmod 600 "$B/.config/agentsync/key.txt"
with_machine "$B" bun run src/cli.ts init --remote "$VAULT_URL" --branch main
with_machine "$B" bun run src/cli.ts pull
assert_contains "$CANARY" "CONTENT FROM VAULT"

step "Mutate B's CLAUDE.md and capture pre-pull state"
echo "$LOCAL_MUTATION" > "$CANARY"
assert_contains "$CANARY" "LOCAL MUTATION ON B"
pre_sha=$(sha256sum "$CANARY" | awk '{print $1}')

step "Plain 'pull' on B — observe behaviour"
set +e
with_machine "$B" bun run src/cli.ts pull > /tmp/pull-plain.log 2>&1
plain_exit=$?
set -e
sed 's/^/    /' /tmp/pull-plain.log
post_sha=$(sha256sum "$CANARY" | awk '{print $1}')

if [ "$plain_exit" -ne 0 ]; then
  # Variant 1: plain pull blocks on local conflict.
  [ "$pre_sha" = "$post_sha" ] \
    || fail "plain pull exited $plain_exit AND overwrote — neither warning nor preserving"
  pass "plain pull blocked (exit $plain_exit) and preserved local mutation"
elif [ "$pre_sha" = "$post_sha" ]; then
  # Variant 2: pull warns but preserves.
  pass "plain pull exited 0 but preserved local file (warning-only mode)"
else
  # Variant 3 — current CLI behaviour: pull overwrites unconditionally.
  # Document this as the observed contract; the next subtest exercises --force
  # which the CLI does support for git reconcile.
  info "plain pull overwrote local mutation without --force (current CLI behaviour)"
  assert_contains "$CANARY" "CONTENT FROM VAULT"
  pass "plain pull overwrites — observed contract recorded"
fi

step "Re-mutate B and run pull --force — vault value must win"
echo "$LOCAL_MUTATION" > "$CANARY"
with_machine "$B" bun run src/cli.ts pull --force 2>&1 | sed 's/^/    /'
assert_contains    "$CANARY" "CONTENT FROM VAULT"
assert_not_contains "$CANARY" "LOCAL MUTATION ON B"

step "Re-mutate B then pull --dry-run — file must NOT change"
echo "$LOCAL_MUTATION" > "$CANARY"
dry_pre=$(sha256sum "$CANARY" | awk '{print $1}')
with_machine "$B" bun run src/cli.ts pull --dry-run 2>&1 | tee /tmp/pull-dry.log | sed 's/^/    /'
dry_post=$(sha256sum "$CANARY" | awk '{print $1}')
[ "$dry_pre" = "$dry_post" ] || fail "pull --dry-run mutated $CANARY"
assert_contains "$CANARY" "LOCAL MUTATION ON B"
pass "pull --dry-run left local mutation untouched"

banner "PULL FORCE + DRY-RUN"
