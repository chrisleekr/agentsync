#!/usr/bin/env bash
# Local-developer driver for the full e2e scenario set.
#
# Iterates docker/e2e/scenarios/*.sh in lexical order, runs each via
# `docker compose run --rm machine`, tracks pass/fail, and tears down the
# stack at the end.
#
# CI uses .github/workflows/e2e.yml's matrix strategy instead — this script
# is for local pre-push validation.
#
# Usage:
#   bash docker/e2e/run-all.sh
#   SCENARIOS="smoke.sh 03-diverged-history.sh" bash docker/e2e/run-all.sh
#   SKIP="11-daemon-ipc.sh" bash docker/e2e/run-all.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${HERE}/compose.yml"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

# Build once, run many.
yellow "▶ Building machine image"
docker compose -f "$COMPOSE_FILE" build machine

cleanup() {
  yellow "▶ Tearing down compose stack"
  docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

yellow "▶ Initializing vault"
docker compose -f "$COMPOSE_FILE" up -d vault-init

# Default scenario set — sorted to match CI matrix ordering.
# Down-sync (`pull`) was removed in favour of `copy`; single-agent restore
# scenarios were converted to `copy self <agent>/`. The multi-agent round-trip,
# per-agent filter loop, and plugin-tree marketplace scenarios were removed:
# their copy-based equivalents (distinct-namespace `copy <machine>` and the
# plugin manifest reinstall) land with the plugin-manifest work.
default_scenarios=(
  smoke.sh
  03-diverged-history.sh
  04-sanitizer-aborts.sh
  05-key-rotate.sh
  06-skill-additive.sh
  09-key-add.sh
  10-migrate.sh
  11-daemon-ipc.sh
  13-doctor.sh
  14-dry-run.sh
  16-vscode-non-mcp.sh
  17-git-protocol.sh
  18-copilot.sh
  19-codex-overrides.sh
  20-home-portability.sh
)

# SCENARIOS env var overrides the full set; SKIP filters from the active set.
read -r -a active_scenarios <<<"${SCENARIOS:-${default_scenarios[*]}}"
read -r -a skip_list <<<"${SKIP:-}"

is_skipped() {
  local name="$1"
  for s in "${skip_list[@]}"; do
    [ "$s" = "$name" ] && return 0
  done
  return 1
}

passed=()
failed=()

for scenario in "${active_scenarios[@]}"; do
  if is_skipped "$scenario"; then
    yellow "▶ SKIP $scenario"
    continue
  fi

  yellow "▶ RUN  $scenario"
  if docker compose -f "$COMPOSE_FILE" run --rm \
       machine "/home/agent/scenarios/${scenario}"; then
    green "✓ PASS $scenario"
    passed+=("$scenario")
  else
    red "✗ FAIL $scenario"
    failed+=("$scenario")
  fi
done

echo
yellow "════════════════════════════════════════════════════════════"
green  "Passed: ${#passed[@]}"
if [ "${#failed[@]}" -gt 0 ]; then
  red "Failed: ${#failed[@]}"
  for f in "${failed[@]}"; do red "  · $f"; done
  exit 1
fi
green "All scenarios passed."
