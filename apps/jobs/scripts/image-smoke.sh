#!/usr/bin/env bash
# Smoke-check the BUILT jobs image — the properties the source-level suite
# cannot see because it never runs the artifact: the image's own runtime user
# and NODE_ENV, the file set it ships (no test files), that its install
# closure boots the service, that /health answers 200 and reports an
# unreachable store honestly, that production refuses the diagnostic job
# type, and that node exits cleanly on SIGTERM as PID 1. CI's images job runs
# this against the loaded image before its push step, so a failing check
# keeps the image off GHCR.
#
# Usage: image-smoke.sh <image-ref>
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "image-smoke: FAIL: usage: image-smoke.sh <image-ref>" >&2
  exit 2
fi
IMAGE="$1"

for tool in docker curl openssl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "image-smoke: FAIL: $tool is required but not on PATH" >&2
    exit 2
  fi
done

fail() {
  echo "image-smoke: FAIL: $1" >&2
  exit 1
}

ok() {
  echo "image-smoke: ok: $1"
}

# One name per run (per check, so the --rm boots can be cleaned up too if a
# timeout leaves one behind); the EXIT trap force-removes every container
# this script started, on success and failure alike.
NAME="helix-jobs-smoke-$$"
STARTED=()
BODY="$(mktemp)"
cleanup() {
  local container
  if [ "${#STARTED[@]}" -gt 0 ]; then
    for container in "${STARTED[@]}"; do
      docker rm -f "$container" >/dev/null 2>&1 || true
    done
  fi
  rm -f "$BODY" >/dev/null 2>&1 || true
}
trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT

# The run-time environment of a configured jobs boot, with the database port
# deliberately unroutable (nothing listens on port 1), so the detached boot
# below exercises the health-first path. Fresh secrets per boot. NODE_ENV is
# never passed: the image bakes it in, and the checks must see the image's
# own value.
ENV_ARGS=()
fresh_env() {
  mapfile -t ENV_ARGS < <(
    printf '%s\n' \
      -e JOBS_SERVER_ID=jobs \
      -e 'JOBS_DATABASE_URL=postgresql://helix_jobs:smoke@127.0.0.1:1/helix_jobs' \
      -e JOBS_ACCEPTING=true \
      -e "JOBS_EDGE_TO_JOBS_SECRET=$(openssl rand -base64 32)" \
      -e "JOBS_PORTAL_TO_JOBS_SECRET=$(openssl rand -base64 32)" \
      -e "JOBS_JOBS_TO_EDGE_SECRET=$(openssl rand -base64 32)" \
      -e JOBS_EDGE_PROD_URL=http://edge.invalid \
      -e JOBS_EDGE_DEV_URL=http://dev-gateway.invalid \
      -e OTEL_SDK_DISABLED=1
  )
}

# 1. Hygiene: the image's own user, its own NODE_ENV, and the file set it
#    ships — pruned of any node_modules anywhere under /app.
HYGIENE_NAME="$NAME-hygiene"
STARTED+=("$HYGIENE_NAME")
rc=0
# shellcheck disable=SC2016  # the snippet is passed verbatim to the container's sh — no expansion here
hygiene_out="$(timeout 60 docker run --rm --name "$HYGIENE_NAME" --entrypoint sh "$IMAGE" -c \
  'id -un; printf "%s\n" "$NODE_ENV"; find /app -name node_modules -prune -o -name "*.test.ts" -print -quit')" || rc=$?
[ "$rc" -eq 0 ] || fail "the hygiene inspection did not run in the image (exit $rc)"
hygiene_user="$(sed -n '1p' <<<"$hygiene_out")"
hygiene_node_env="$(sed -n '2p' <<<"$hygiene_out")"
hygiene_test_file="$(sed -n '3p' <<<"$hygiene_out")"
[ "$hygiene_user" = "node" ] || fail "the image runs as '$hygiene_user', not the unprivileged 'node' user"
[ "$hygiene_node_env" = "production" ] || fail "the image does not run with NODE_ENV=production (got '$hygiene_node_env')"
[ -z "$hygiene_test_file" ] || fail "the image ships a test file: $hygiene_test_file"
ok "hygiene (runs as node, NODE_ENV=production, no test files)"

# 2. Missing configuration refuses to boot: the config loader crashes the
#    boot with the missing key named, before anything listens.
NOENV_NAME="$NAME-noenv"
STARTED+=("$NOENV_NAME")
rc=0
noenv_out="$(timeout 60 docker run --rm --name "$NOENV_NAME" "$IMAGE" 2>&1)" || rc=$?
if [ "$rc" -eq 124 ]; then
  fail "a boot with no configuration is still running after 60s (timed out) — it must refuse to start"
fi
if [ "$rc" -eq 0 ]; then
  fail "the image boots with no configuration (exit 0) — it must refuse: JOBS_SERVER_ID is required"
fi
grep -q 'JOBS_SERVER_ID is required' <<<"$noenv_out" \
  || fail "the no-config boot exited $rc but never named the missing configuration (expected 'JOBS_SERVER_ID is required'); its output ended:
$(tail -n 5 <<<"$noenv_out")"
ok "missing configuration refuses to boot"

# 3. The diagnostic job type is refused in production: with the full smoke
#    environment plus JOBS_DIAGNOSTICS=true, the config loader refuses.
DIAG_NAME="$NAME-diagnostics"
STARTED+=("$DIAG_NAME")
fresh_env
rc=0
diag_out="$(timeout 60 docker run --rm --name "$DIAG_NAME" \
  "${ENV_ARGS[@]}" -e JOBS_DIAGNOSTICS=true "$IMAGE" 2>&1)" || rc=$?
if [ "$rc" -eq 124 ]; then
  fail "the diagnostics boot is still running after 60s (timed out) — production must refuse JOBS_DIAGNOSTICS"
fi
if [ "$rc" -eq 0 ]; then
  fail "the image booted with JOBS_DIAGNOSTICS=true (exit 0) — production must refuse the diagnostic job type"
fi
grep -q 'JOBS_DIAGNOSTICS cannot be enabled in production' <<<"$diag_out" \
  || fail "the diagnostics boot exited $rc but never named the refusal (expected 'JOBS_DIAGNOSTICS cannot be enabled in production'); its output ended:
$(tail -n 5 <<<"$diag_out")"
ok "the diagnostic job type is refused in production"

# 4. Health-first boot with no reachable store: the listener comes up before
#    the store is usable, /health answers 200, and the body reports the
#    unreachable store as an error — never as health.
BOOT_NAME="$NAME-boot"
STARTED+=("$BOOT_NAME")
fresh_env
docker run -d --name "$BOOT_NAME" -p 127.0.0.1::3003 \
  "${ENV_ARGS[@]}" "$IMAGE" >/dev/null \
  || fail "the detached boot run failed to start"
rc=0
port_line="$(docker port "$BOOT_NAME" 3003/tcp | sed -n '1p')" || rc=$?
if [ "$rc" -ne 0 ] || [ -z "$port_line" ]; then
  fail "could not read the published port for $BOOT_NAME from docker port"
fi
port="${port_line##*:}"
answered=0
code=""
i=0
while [ "$i" -lt 60 ]; do
  rc=0
  code="$(curl -s -o "$BODY" -w '%{http_code}' "http://127.0.0.1:$port/health")" || rc=$?
  if [ "$rc" -eq 0 ]; then
    answered=1
    break
  fi
  running="$(docker inspect -f '{{.State.Running}}' "$BOOT_NAME" 2>/dev/null || true)"
  if [ "$running" != "true" ]; then
    fail "the container exited before /health answered — the image's own boot failed; last 40 log lines:
$(docker logs "$BOOT_NAME" 2>&1 | tail -n 40)"
  fi
  i=$((i + 1))
  sleep 1
done
[ "$answered" -eq 1 ] || fail "/health never answered within 60s (polling http://127.0.0.1:$port/health)"
[ "$code" = "200" ] || fail "/health answered $code — the health contract always answers 200"
grep -q '"service":"helix-jobs"' "$BODY" \
  || fail "the /health body does not name the service (expected \"service\":\"helix-jobs\")"
grep -q '^{"status":"error"' "$BODY" \
  || fail "the /health body does not open with a top-level status error (an unreachable store must never look healthy)"
grep -q '"name":"jobs_database","status":"error"' "$BODY" \
  || fail "the /health body does not report the jobs_database check as error (an unreachable store must never look healthy)"
ok "health-first boot with no reachable store (200, honest error)"

# 5. Graceful stop: node is PID 1 and drains on SIGTERM — the exit code says
#    whether the drain ran or the runtime had to SIGKILL.
docker stop -t 20 "$BOOT_NAME" >/dev/null || fail "docker stop failed for $BOOT_NAME"
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$BOOT_NAME")"
[ "$exit_code" = "0" ] || fail "the container exited with code $exit_code on SIGTERM — 137 would mean the runtime SIGKILLed it before the drain finished"
docker rm "$BOOT_NAME" >/dev/null || fail "could not remove $BOOT_NAME after the graceful stop"
ok "graceful stop (SIGTERM drains, exit 0)"

echo "image-smoke: all checks passed"
