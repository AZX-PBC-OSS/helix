---
title: Contributing
---

# Contributing

Helix is open source at
[github.com/AZX-PBC-OSS/helix](https://github.com/AZX-PBC-OSS/helix). This site
holds the operator and app-author guides; everything contributor-facing lives
in the repo itself, browsable on GitHub.

## Where to look in the repo

- [`TOUR.md`](https://github.com/AZX-PBC-OSS/helix/blob/main/TOUR.md) — a map of
  the codebase and where to start reading.
- [`docs/`](https://github.com/AZX-PBC-OSS/helix/tree/main/docs) — contributor
  documentation, sorted by kind:
  - `adr/` — one architecture decision per file, with context and consequences.
  - `features/` — how each shipped capability works today.
  - `design/` — designs written ahead of or alongside the code.
  - `runbooks/` — operational procedures.
- [`TODO.md`](https://github.com/AZX-PBC-OSS/helix/blob/main/TODO.md) — open
  follow-up work.

## Building and checking

The dev container provides Node 24, pnpm, Postgres, and Azurite. From the repo
root:

```bash
pnpm install
./check-and-lint.sh   # typecheck + lint + format + docs build + tests — the CI gate
pnpm dev:edge         # …and the other dev:* services, see the docs
```

The [local development page](/deploy/local-dev) covers running the full stack.

## About this site

This site is built with VitePress from [`apps/docs`](https://github.com/AZX-PBC-OSS/helix/tree/main/apps/docs)
and published to GitHub Pages. Fixes welcome — the content source is plain
markdown.
