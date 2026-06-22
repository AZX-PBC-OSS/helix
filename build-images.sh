#!/usr/bin/env bash
# Throwaway helper: build (and optionally push) the three Helix app images.
# Run from the repo ROOT on a host with Docker — the build context is the whole
# pnpm workspace. NOT committed; delete when you're done.
#
# Usage:
#   ./build-images.sh                              # build all three, local only
#   REGISTRY=helixprodacr.azurecr.io ./build-images.sh        # tag for ACR
#   REGISTRY=helixprodacr.azurecr.io PUSH=1 ./build-images.sh # build + push
#   TAG=v0.1.0 ./build-images.sh                   # explicit tag
#   PLATFORM=linux/arm64 ./build-images.sh         # override target arch
#   ./build-images.sh edge                         # just one (edge|portal|egress)
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
    *)      echo "" ;;
  esac
}

# Which apps to build (all, or the ones named on the command line).
if [[ $# -eq 0 ]]; then
  APPS=(edge portal egress)
else
  APPS=("$@")
fi

prefix=""
[[ -n "$REGISTRY" ]] && prefix="${REGISTRY%/}/"

echo "platform=$PLATFORM tag=$TAG registry=${REGISTRY:-<local>} push=$PUSH"
echo

for app in "${APPS[@]}"; do
  meta="$(app_meta "$app")"
  if [[ -z "$meta" ]]; then
    echo "error: unknown app '$app' (expected edge|portal|egress)" >&2
    exit 1
  fi
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
