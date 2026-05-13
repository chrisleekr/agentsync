#!/usr/bin/env bash
set -euo pipefail

# AgentSync E2E entrypoint — rsync the complete-real-customer fixture tree into
# the container's HOME, then exec whatever scenario the compose CMD selected.
# *.bak and *~ patterns are excluded so the never-sync canary rule (B21) is
# exercised by scenarios that explicitly plant them.

if [ "$(id -u)" = "0" ]; then
  echo "FATAL: entrypoint must not run as root" >&2
  exit 1
fi

if [ "${HOME:-}" != "/home/agent" ]; then
  echo "FATAL: HOME must be /home/agent inside container, got: ${HOME:-unset}" >&2
  exit 1
fi

# Drift detection — keep upstream CLIs honest on every container start.
# `--version` exits non-zero on a corrupt install; pipefail propagates the
# failure to the entrypoint so a broken @latest image fails fast.
echo "[bootstrap] CLI drift check"
claude --version       >/dev/null
codex --version        >/dev/null
cursor-agent --version >/dev/null

# Codex's `--version` doesn't write auth.json; scenarios that need a stub
# credential canary plant it explicitly from docker/e2e/fixtures/canaries.
# We do still run `codex login --with-api-key` once with a stub so the
# auth.json path exists for scenarios that exercise its never-sync behaviour.
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-stub-for-bootstrap}"
printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null

# Fixture install. `rsync -a` is additive — it copies fixtures/home/* onto
# HOME without touching siblings (.bun, .npm-global, fixtures, scenarios,
# scripts, entrypoint.sh). We deliberately do NOT pass --delete: HOME and
# the fixture source share a parent, so --delete would wipe the toolchain.
# `*.bak` and `*~` are excluded so that backup-file canaries planted later
# under a scenario's machine HOME do not leak in here.
rsync -a \
  --exclude='*.bak' --exclude='*~' \
  /home/agent/fixtures/home/ /home/agent/

echo "[bootstrap] complete — agent home rooted at $HOME"
exec "$@"
