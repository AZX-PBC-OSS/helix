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

# Apply the Helix overlay patches to the upstream clone (our fork's diff, kept
# out of the gitignored clone so they're version-controlled here).
for p in "$here"/patches/*.patch; do
  [ -e "$p" ] || continue
  name="$(basename "$p")"
  if git -C "$clone" apply --reverse --check "$p" 2>/dev/null; then
    echo "→ patch already applied: $name"
  elif git -C "$clone" apply "$p" 2>/dev/null; then
    echo "→ applied patch: $name"
  else
    echo "⚠ could not apply patch (upstream drift?): $name" >&2
  fi
done

echo "✓ setup complete — run: builder/run.sh"
