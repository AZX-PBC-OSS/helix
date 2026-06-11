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

echo "── Enabling pnpm via corepack ──"
corepack enable pnpm
export PATH="/home/node/.local/share/pnpm/bin:$PATH"
pnpm config set store-dir /home/node/.pnpm-store --global

echo "── Installing Playwright system deps ──"
sudo env "PATH=$PATH" npx -y playwright@latest install-deps chromium

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
