#!/usr/bin/env bash
set -euo pipefail

echo "── Fixing volume ownership ──"
# Named-volume mountpoints are created root-owned by Docker; hand them to node.
sudo chown "$(id -u):$(id -g)" \
  /workspace/node_modules \
  /home/node/.pnpm-store \
  /home/node/.cache/ms-playwright \
  /home/node/.codex \
  /home/node/.config \
  /home/node/.config/opencode \
  /home/node/.local/share/opencode
sudo chown -R "$(id -u):$(id -g)" /home/node/.claude

echo "── Initializing Claude config ──"
# Keep .claude.json inside the named volume so it survives rebuilds, then
# symlink it to the home path Claude Code expects.
if [ ! -f ~/.claude/.claude.json ]; then
  echo '{}' > ~/.claude/.claude.json
fi
ln -sf ~/.claude/.claude.json ~/.claude.json

echo "── Configuring pnpm store ──"
# corepack is enabled at image build (Dockerfile); just point the store at the
# named volume. PATH tweak so pnpm's global-bin check doesn't abort the write.
export PATH="/home/node/.local/share/pnpm/bin:$PATH"
pnpm config set store-dir /home/node/.pnpm-store --global

echo "── Installing Playwright system deps ──"
sudo env "PATH=$PATH" npx -y playwright@latest install-deps chromium

echo "── Generating local TLS certs (mkcert) ──"
# Wildcard cert for *.localtest.me so the edge can terminate TLS in dev —
# __Host- cookies demand Secure (project plan §3). Idempotent; gitignored.
# NODE_EXTRA_CA_CERTS (compose) makes Node trust the CA in-container; to quiet
# host-browser warnings, import certs/caroot/rootCA.pem into the host trust
# store (optional — the warning is harmless for dev).
CERT_DIR=/workspace/.devcontainer/certs
export CAROOT="$CERT_DIR/caroot"
if [ ! -f "$CERT_DIR/localtest-me.pem" ] && command -v mkcert >/dev/null; then
  mkdir -p "$CAROOT"
  mkcert -cert-file "$CERT_DIR/localtest-me.pem" \
         -key-file "$CERT_DIR/localtest-me-key.pem" \
         "*.localtest.me" localtest.me
fi

# ── Workspace install (guarded) ──
# The monorepo isn't scaffolded yet (M0). Only install once a workspace exists.
if [ -f /workspace/package.json ] || [ -f /workspace/pnpm-workspace.yaml ]; then
  echo "── Installing workspace dependencies ──"
  cd /workspace && CI=true pnpm install

  echo "── Pre-caching Playwright browser ──"
  npx -y playwright@latest install chromium
else
  echo "── No workspace package.json yet — skipping pnpm install ──"
fi

echo "── Done! ──"
