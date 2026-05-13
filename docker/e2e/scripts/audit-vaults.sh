#!/usr/bin/env bash
# Decrypted-blob audit. Walks every bare git repo under /vault, decrypts every
# `.age` blob using the agentsync key, and greps the plaintext against every
# pattern in sanitizer's EMBEDDED_SECRET_PATTERNS list. Any match is a leak.
#
# This is the canary against issue #47 (markdown bodies sneaking literal secrets
# past the sanitizer). It runs as a separate CI job after the scenario matrix.

set -euo pipefail

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

# Patterns mirror src/core/sanitizer.ts EMBEDDED_SECRET_PATTERNS verbatim.
# When the sanitizer list changes, update this array in lockstep.
PATTERNS=(
  'sk-ant-api03-[A-Za-z0-9_-]{40,}'
  'sk-proj-[A-Za-z0-9_-]{40,}'
  'ghp_[A-Za-z0-9]{36}'
  'github_pat_[A-Za-z0-9_]{80,}'
  'glpat-[A-Za-z0-9_-]{20,}'
  'AKIA[0-9A-Z]{16}'
  'AIza[0-9A-Za-z_-]{35}'
  'xox[abprs]-[A-Za-z0-9-]{10,}'
)

KEY_FILE="${AGENTSYNC_KEY_FILE:-$HOME/.config/agentsync/key.txt}"
if [ ! -f "$KEY_FILE" ]; then
  red "audit: key file missing at $KEY_FILE — run a scenario first"
  exit 1
fi

shopt -s nullglob
vault_dirs=( /vault/*.git )
shopt -u nullglob

if [ "${#vault_dirs[@]}" -eq 0 ]; then
  red "audit: no /vault/*.git repos found — run a scenario first"
  exit 1
fi

leaks=()

for vault in "${vault_dirs[@]}"; do
  green "▶ Auditing $vault"
  blobs=$(git --git-dir="$vault" ls-tree -r HEAD 2>/dev/null | awk '$4 ~ /\.age$/ {print $4}')
  [ -z "$blobs" ] && continue

  while IFS= read -r path; do
    [ -z "$path" ] && continue
    plaintext=$(git --git-dir="$vault" show "HEAD:${path}" \
                | age -d -i "$KEY_FILE" 2>/dev/null || true)
    [ -z "$plaintext" ] && continue
    for pat in "${PATTERNS[@]}"; do
      if printf '%s' "$plaintext" | grep -Eq "$pat"; then
        leaks+=("$vault::$path matched /$pat/")
      fi
    done
  done <<<"$blobs"
done

if [ "${#leaks[@]}" -gt 0 ]; then
  red "audit: ${#leaks[@]} leak(s) found:"
  for L in "${leaks[@]}"; do red "  · $L"; done
  exit 1
fi

green "audit: no plaintext secret patterns found in any vault blob"
