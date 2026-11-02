#!/usr/bin/env bash
# Build (and optionally push) the four Helix app images: the three runtime
# services (edge, portal, egress) and the jobs runner. Committed — it builds
# the same Dockerfiles from the same context CI's `images` job does, as the
# local/manual path for the same artifacts. Run from the repo ROOT on a host
# with Docker — the build context is the whole pnpm workspace.
#
# Usage:
#   ./build-images.sh                              # build all four, local only
#   REGISTRY=helixprodacr.azurecr.io ./build-images.sh        # tag for ACR
#   REGISTRY=helixprodacr.azurecr.io PUSH=1 ./build-images.sh # build + push
#   TAG=v0.1.0 ./build-images.sh                   # explicit tag
#   PLATFORM=linux/arm64 ./build-images.sh         # override target arch
#   ./build-images.sh jobs                         # just one (edge|portal|egress|jobs)
#
# Env vars:
#   REGISTRY  ACR login server (e.g. helixprodacr.azurecr.io). Empty = local tags.
#   TAG       Image tag. Default: short git SHA, else "latest".
#   PUSH      "1" to docker push after building (requires REGISTRY + a login).
#   PLATFORM  Target platform. Default linux/amd64 (Azure Container Apps is amd64).
#
# NOTE: the ACR provisioned by the Bicep is private (public access disabled), so
# a plain `docker push` only works from inside the VNet (jump box / build agent).
# From elsewhere, prefer building inside the registry instead:
#   az acr build -r helixprodacr -t helix-edge:$TAG   -f apps/edge/Dockerfile   .
#   az acr build -r helixprodacr -t helix-portal:$TAG -f apps/portal/Dockerfile .
#   az acr build -r helixprodacr -t helix-egress:$TAG -f apps/egress/Dockerfile .
#   az acr build -r helixprodacr -t helix-jobs:$TAG   -f apps/jobs/Dockerfile   .

set -euo pipefail

REGISTRY="${REGISTRY:-}"
PUSH="${PUSH:-0}"
PLATFORM="${PLATFORM:-linux/amd64}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"

# Ensure we run from the repo root (where the app Dockerfiles' context lives).
cd "$(dirname "$0")"
if [[ ! -f pnpm-workspace.yaml ]]; then
  echo "error: run this from the repo root (pnpm-workspace.yaml not found here)" >&2
  exit 1
fi

# Map app name -> "Dockerfile|repo". Plain case statement (no associative
# arrays) so this runs on stock macOS bash 3.2.
app_meta() {
  case "$1" in
    edge)   echo "apps/edge/Dockerfile|helix-edge" ;;
    portal) echo "apps/portal/Dockerfile|helix-portal" ;;
    egress) echo "apps/egress/Dockerfile|helix-egress" ;;
    jobs)   echo "apps/jobs/Dockerfile|helix-jobs" ;;
    *)      echo "" ;;
  esac
}

# Which apps to build (all, or the ones named on the command line).
if [[ $# -eq 0 ]]; then
  APPS=(edge portal egress jobs)
else
  APPS=("$@")
fi

# Validate the request before deciding capability: a mistyped app name is a
# caller error on every host, builder or not, and so is a mapped app whose
# Dockerfile does not exist — the packaging wiring must be whole before the
# builder question even arises (the no-docker skip below otherwise passes
# over a broken map).
for app in "${APPS[@]}"; do
  meta="$(app_meta "$app")"
  if [[ -z "$meta" ]]; then
    echo "error: unknown app '$app' (expected edge|portal|egress|jobs)" >&2
    exit 1
  fi
  if [[ ! -f "${meta%%|*}" ]]; then
    echo "error: $app's Dockerfile is missing: ${meta%%|*}" >&2
    exit 1
  fi
done

# No docker on this host means no build can run here. The dev container has no
# container builder, by policy, and image builds are enforced by CI's image
# job on every push — so the absence of the tool is a skip, reported loudly,
# not a silent pass. A PRESENT-but-broken docker (daemon down) still fails:
# only the tool's absence skips; PUSH=1 never skips, because an explicit
# push request must not degrade into doing nothing.
if ! command -v docker >/dev/null 2>&1; then
  if [[ "$PUSH" == "1" ]]; then
    echo "error: PUSH=1 needs docker on this host (docker: command not found)" >&2
    exit 1
  fi
  echo "skipping image builds: no docker on this host — this environment has no container builder, by policy." >&2
  echo "The images build in CI's image job on every push; run this script on a docker host to build locally." >&2
  exit 0
fi

prefix=""

[[ -n "$REGISTRY" ]] && prefix="${REGISTRY%/}/"

echo "platform=$PLATFORM tag=$TAG registry=${REGISTRY:-<local>} push=$PUSH"
echo

for app in "${APPS[@]}"; do
  meta="$(app_meta "$app")"
  dockerfile="${meta%%|*}"
  repo="${meta##*|}"
  image="${prefix}${repo}:${TAG}"
  echo "==> building $image"
  docker build --platform "$PLATFORM" -f "$dockerfile" -t "$image" .

  if [[ "$PUSH" == "1" ]]; then
    if [[ -z "$REGISTRY" ]]; then
      echo "error: PUSH=1 needs REGISTRY set" >&2
      exit 1
    fi
    echo "==> pushing $image"
    docker push "$image"
  fi
done

echo
echo "done."
[[ -n "$REGISTRY" && "$PUSH" != "1" ]] && \
  echo "tagged but not pushed — re-run with PUSH=1, or use 'az acr build' for the private registry."
exit 0
