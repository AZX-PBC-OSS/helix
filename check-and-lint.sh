#!/usr/bin/env bash
#
# check-and-lint.sh — poor man's CI.
#
# Runs typecheck, lint, format check, and tests. Each step runs even if an
# earlier one fails, so you get the full picture in one pass. Exits non-zero
# if any step failed.
#
# Usage:
#   ./check-and-lint.sh          # run all checks
#   ./check-and-lint.sh --fix    # auto-fix lint + formatting, then run checks

set -uo pipefail

cd "$(dirname "$0")"

FIX=0
if [[ "${1:-}" == "--fix" ]]; then
  FIX=1
fi

# Track failures so we can run every step and report at the end.
FAILED=()

run_step() {
  local name="$1"
  shift
  echo ""
  echo "▶ ${name}"
  echo "  \$ $*"
  if "$@"; then
    echo "✔ ${name} passed"
  else
    echo "✗ ${name} FAILED"
    FAILED+=("${name}")
  fi
}

if [[ "${FIX}" -eq 1 ]]; then
  echo "Auto-fixing lint + formatting before checks..."
  pnpm lint:fix || true
  pnpm format || true
fi

run_step "typecheck" pnpm typecheck
run_step "lint"      pnpm lint
run_step "format"    pnpm format:check
run_step "tests"     pnpm test

echo ""
echo "────────────────────────────────────────"
if [[ "${#FAILED[@]}" -eq 0 ]]; then
  echo "✔ All checks passed"
  exit 0
else
  echo "✗ ${#FAILED[@]} step(s) failed: ${FAILED[*]}"
  exit 1
fi
