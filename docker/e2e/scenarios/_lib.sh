#!/usr/bin/env bash
# Shared assertion helpers for AgentSync E2E scenarios.

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

step() { yellow "▶ $*"; }
pass() { green "  ✓ $*"; }
fail() { red   "  ✗ $*"; exit 1; }

assert_file_exists() {
  [ -f "$1" ] || fail "expected file missing: $1"
  pass "file exists: $1"
}

assert_dir_exists() {
  [ -d "$1" ] || fail "expected dir missing: $1"
  pass "dir exists: $1"
}

assert_contains() {
  local file="$1" needle="$2"
  grep -qF "$needle" "$file" || fail "expected '$needle' in $file"
  pass "contains '$needle': $file"
}
