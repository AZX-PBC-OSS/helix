#!/usr/bin/env bash
# One-time setup for the bolt.diy prototype ("Lovable at home", Track B).
# Clones upstream bolt.diy into the gitignored builder/bolt.diy/ and installs it
# standalone (--ignore-workspace so pnpm doesn't fold it into the Helix
# workspace). Re-runnable: skips the clone if it already exists.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
clone="$here/bolt.diy"

if [[ ! -d "$clone" ]]; then
  echo "→ cloning stackblitz-labs/bolt.diy"
  git clone --depth 1 https://github.com/stackblitz-labs/bolt.diy.git "$clone"
fi

if [[ ! -f "$clone/.env.local" ]]; then
  echo "→ seeding bolt.diy/.env.local from bolt.env.example (edit the key if you like)"
  cp "$here/bolt.env.example" "$clone/.env.local"
fi

echo "→ installing deps (standalone)"
cd "$clone"
pnpm install --ignore-workspace

echo "✓ setup complete — run: builder/run.sh"
