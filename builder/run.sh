#!/usr/bin/env bash
# Launch the bolt.diy prototype wired to the Helix builder gateway (Track A).
#
# Handles the two things a stock `pnpm dev` in the clone can't know about:
#   1. NODE_EXTRA_CA_CERTS — bolt's server-side fetch to the edge speaks TLS to
#      the mkcert-signed https://api.localtest.me:8080; Node must trust the dev
#      root CA or every LLM call fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
#   2. Port — bolt defaults to :5173, which collides with `pnpm dev:web`
#      (portal-web). We move it to :5180.
#
# The OPENAI_LIKE_* wiring lives in bolt.diy/.env.local (gitignored); we source
# it so the key never lands in this committed script.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
clone="$here/bolt.diy"

if [[ ! -d "$clone" ]]; then
  echo "bolt.diy not cloned yet — run: builder/setup.sh" >&2
  exit 1
fi

# Export the gateway wiring from the clone's .env.local (OPENAI_LIKE_*).
set -a
# shellcheck disable=SC1091
[[ -f "$clone/.env.local" ]] && . "$clone/.env.local"
set +a

export NODE_EXTRA_CA_CERTS="/workspace/.devcontainer/certs/caroot/rootCA.pem"

echo "bolt.diy → ${OPENAI_LIKE_API_BASE_URL:-<unset>}  (CA: $NODE_EXTRA_CA_CERTS)"
cd "$clone"
# NB: invoke remix directly, not `pnpm dev -- --host --port`: pnpm inserts a `--`
# that remix's `vite:dev [ROOT]` parser treats as the project root ("--host"),
# which then can't find the vite config ("Remix Vite plugin not found").
node pre-start.cjs || true
exec pnpm exec remix vite:dev --host --port 5180
