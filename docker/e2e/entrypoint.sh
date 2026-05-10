#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
  echo "FATAL: entrypoint must not run as root" >&2
  exit 1
fi

if [ "${HOME:-}" != "/home/agent" ]; then
  echo "FATAL: HOME must be /home/agent inside container, got: ${HOME:-unset}" >&2
  exit 1
fi

# Bootstrap matrix (verified empirically against the installed CLIs):
#   - Codex `--version` creates ~/.codex/. `codex login --with-api-key` adds auth.json.
#   - cursor-agent `--version` creates ~/.cursor/cli-config.json.
#   - Claude Code 2.x `--version` creates NOTHING. The CLI is intentionally lazy:
#     ~/.claude is only written during a real interactive session. We install the
#     real binary (proves npm install works, exposes schema drift) but create a
#     minimal settings.json fixture representing a real-customer state.

echo "[bootstrap] claude (real npm install + fixture for ~/.claude)"
claude --version
mkdir -p "$HOME/.claude"
[ -f "$HOME/.claude/settings.json" ] || \
  echo '{"theme": "dark"}' > "$HOME/.claude/settings.json"

echo "[bootstrap] codex (real install + login with stub key)"
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-stub-for-bootstrap}"
codex --version
printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key

echo "[bootstrap] cursor-agent (real install + version)"
cursor-agent --version

# Editor settings.json — documented fixtures.
# VS Code and Cursor desktop (Electron) do not auto-write settings.json on launch
# (microsoft/vscode#44418). The fixtures below represent a real-customer state
# (one saved preference). See docker/e2e/README.md for the full rationale.
mkdir -p "$HOME/.config/Code/User" "$HOME/.config/Cursor/User"
[ -f "$HOME/.config/Code/User/settings.json" ] || \
  echo '{"editor.fontSize": 14}' > "$HOME/.config/Code/User/settings.json"
[ -f "$HOME/.config/Cursor/User/settings.json" ] || \
  echo '{"rules": "test rule from fixture"}' > "$HOME/.config/Cursor/User/settings.json"

echo "[bootstrap] complete. agent home contents:"
ls -la "$HOME" | head -25

exec "$@"
