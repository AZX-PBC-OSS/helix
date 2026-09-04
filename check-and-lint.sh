#!/usr/bin/env bash
#
# check-and-lint.sh — poor man's CI.
#
# Runs typecheck, lint, format check, and tests. Each step runs even if an
# earlier one fails, so you get the full picture in one pass. Exits non-zero
# if any step failed. Each step reports its own wall time, and the summary
# reports the total — CI reads those numbers to keep the job split honest.
#
# Usage:
#   ./check-and-lint.sh                        # run all checks
#   ./check-and-lint.sh --fix                  # auto-fix lint + formatting first
#   ./check-and-lint.sh typecheck lint format  # run only the named steps
#   ./check-and-lint.sh test -- --shard=1/3    # extra args for the test step
#
# Naming steps is what lets CI split the work across two jobs (.github/
# workflows/ci.yml) while still running *this* script rather than a divergent
# copy of the commands: the `static` job runs the first three, the `test` job
# runs the last one, and both keep the run-every-step-then-report-all
# behaviour. With no step names, every step runs — the local default.
#
# Anything after `--` is appended to the test step's command line, which is how
# CI shards the suite (`-- --shard=1/3`). It is rejected unless `test` is the
# only named step: vitest flags mean nothing to tsc or eslint, and silently
# ignoring them is exactly the failure this guards against.

set -uo pipefail

cd "$(dirname "$0")"

ALL_STEPS=(typecheck lint format test)

FIX=0
STEPS=()
# Extra args for the test step, everything after a literal `--`.
TEST_ARGS=()

while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--" ]]; then
    shift
    TEST_ARGS=("$@")
    break
  fi
  arg="$1"
  shift
  case "${arg}" in
    --fix)
      FIX=1
      ;;
    -h | --help)
      # Reprint the header comment block, minus the shebang and the leading "# ".
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    -*)
      echo "unknown option: ${arg}" >&2
      echo "usage: $0 [--fix] [${ALL_STEPS[*]}]" >&2
      exit 2
      ;;
    *)
      # shellcheck disable=SC2076 # literal match is intended
      if [[ ! " ${ALL_STEPS[*]} " =~ " ${arg} " ]]; then
        echo "unknown step: ${arg}" >&2
        echo "usage: $0 [--fix] [${ALL_STEPS[*]}]" >&2
        exit 2
      fi
      STEPS+=("${arg}")
      ;;
  esac
done

if [[ "${#STEPS[@]}" -eq 0 ]]; then
  STEPS=("${ALL_STEPS[@]}")
fi

# Passthrough args only make sense for a lone `test` step — see the header.
if [[ "${#TEST_ARGS[@]}" -gt 0 && "${STEPS[*]}" != "test" ]]; then
  echo "args after -- apply to the test step, so 'test' must be the only step named" >&2
  echo "usage: $0 [--fix] [${ALL_STEPS[*]}] [-- <vitest args>]" >&2
  exit 2
fi

# Track failures so we can run every step and report at the end.
FAILED=()
# Per-step wall time, collected for the summary line.
TIMINGS=()

wants() {
  # shellcheck disable=SC2076 # literal match is intended
  [[ " ${STEPS[*]} " =~ " $1 " ]]
}

run_step() {
  local name="$1"
  shift
  local start=${SECONDS}
  echo ""
  echo "▶ ${name}"
  echo "  \$ $*"
  if "$@"; then
    local elapsed=$((SECONDS - start))
    echo "✔ ${name} passed (${elapsed}s)"
  else
    local elapsed=$((SECONDS - start))
    echo "✗ ${name} FAILED (${elapsed}s)"
    FAILED+=("${name}")
  fi
  TIMINGS+=("${name}=${elapsed}s")
}

TOTAL_START=${SECONDS}

if [[ "${FIX}" -eq 1 ]]; then
  echo "Auto-fixing lint + formatting before checks..."
  pnpm lint:fix || true
  # --log-level warn: `prettier --write` otherwise names all ~300 files it looked
  # at, which buries every warning the steps below emit. The format step re-checks.
  pnpm format --log-level warn || true
fi

wants typecheck && run_step "typecheck" pnpm typecheck
wants lint && run_step "lint" pnpm lint
wants format && run_step "format" pnpm format:check
# `pnpm test --shard=…`, NOT `pnpm test -- --shard=…`: pnpm swallows args after
# a second `--` and vitest never sees them, so the shard silently runs the whole
# suite and the job still goes green. Verified — do not "fix" this to the `--`
# form.
wants test && run_step "tests" pnpm test "${TEST_ARGS[@]}"

echo ""
echo "────────────────────────────────────────"
echo "timing: ${TIMINGS[*]} total=$((SECONDS - TOTAL_START))s"
if [[ "${#FAILED[@]}" -eq 0 ]]; then
  echo "✔ All checks passed"
  exit 0
else
  echo "✗ ${#FAILED[@]} step(s) failed: ${FAILED[*]}"
  exit 1
fi
