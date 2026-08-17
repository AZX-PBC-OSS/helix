# Malformed bundle fixtures

Real upload shapes users produced when asked to "zip the contents of your `dist`
directory", reconstructed as entry lists in
[`malformed-bundles.ts`](./malformed-bundles.ts).

**These are reconstructions, not the originals.** Structure is faithful — entry
order, directory records, junk sidecars, byte-for-byte `src`/`dist` duplication,
relative-vs-absolute references — and the content is stubbed to a few bytes. The
originals carried a real app's manifest grants and client-facing marketing copy,
neither of which belongs in the repo.

Each fixture also declares `canonical`: the bundle-relative paths a _correct_
upload of the same app would have carried. A test can then state the gap between
what arrived and what was meant without re-deriving it, and whatever eventually
does the re-rooting has its expected output written down.

## `PROJECT_ROOT_MACOS` — zipped the project root

26 entries: 10 files, 3 directory records, 13 macOS junk entries.

```
helix-app/                              ← single top-level wrapper
├── helix.json                          ★ {"slug":"example-app","dir":"dist"}
├── package.json                        ▲ "build": "node build.mjs"
├── build.mjs                           ▲ the build is a file copy, src/ → dist/
├── manifest.json                       ◆ a full AppManifest: visibility + grants
├── dist/                               ← the answer
│   ├── index.html                        refs ./styles.css, ./app.js
│   ├── styles.css
│   └── app.js
└── src/                                ← byte-identical decoy
    ├── index.html                        same bytes as dist/index.html
    ├── styles.css                        same bytes
    └── app.js                            same bytes

__MACOSX/                               ✗ 13 AppleDouble sidecars, interleaved
├── ._helix-app                          ← entry #2. This is where the deploy dies.
├── helix-app/._helix.json
├── helix-app/._dist
├── helix-app/._package.json
├── helix-app/._build.mjs
├── helix-app/._manifest.json
├── helix-app/._src
├── helix-app/dist/._index.html
├── helix-app/dist/._styles.css
├── helix-app/dist/._app.js
├── helix-app/src/._index.html
├── helix-app/src/._styles.css
└── helix-app/src/._app.js
```

Why it's worth keeping:

- **The archive carries its own answer.** `helix.json` names `dir: "dist"`.
  It is entry #3 — one entry after the junk that fails the deploy.
- **No content signal separates `src/` from `dist/`.** The "build" is
  `cp src/* dist/`: no bundler, no hashing, no minification. Resolving
  `index.html`'s references succeeds against _either_ directory, so a
  reference-resolution check cannot pick the root here. Only the declared
  config, the directory name, or asking the user can.
- **Junk starts at entry #2**, so any error that reports the first offending
  entry reports junk before it reports anything true. That is the
  `file type not allowed (static files only): __MACOSX/._helix-app` message
  users can make no sense of.
- **Accepting this root would publish source.** `package.json`, `build.mjs`,
  `manifest.json` (which enumerates the app's grants and spend caps) and every
  file under `src/` are all on the mime allowlist, so they would be served from
  the app origin. Re-rooting is a confidentiality control, not only an
  ergonomic one.

## `WRAPPER_DIR` — zipped the folder itself

8 entries: 8 files, no directory records, no junk.

```
marketing-site/                         ← single wrapper, no build dir anywhere
├── index.html                            refs assets/{styles.css,app.js,logo.png}
├── problem.html                          + 4 sibling page links
├── prototype-to-production.html
├── who-its-for.html
├── workspace.html
└── assets/
    ├── app.js
    ├── logo.png
    └── styles.css
```

Why it's worth keeping:

- **It deploys green and serves a 404 at `/`.** Every extension is allowed, so
  validation passes. The only signal is the `index.html` advisory in the
  warning list — and the fixture keeps an allowlisted CDN origin
  (`fonts.googleapis.com`) precisely so the CSP lint stays silent and that
  advisory arrives with nothing beside it. This is the failure mode that a
  stricter error, not a better message, has to catch.
- **Every reference is relative**, so stripping the wrapper is safe. Worth
  noting how lucky that is: a default `base: "/"` build produces root-absolute
  references, which survive re-rooting but break under scope-nesting.
- **The wrapper name looks like an app slug** — which is a usable signal that
  it's a wrapper, and the exact inverse of a correctly-nested offline bundle,
  where the top directory matches the granted service-worker scope and must be
  _kept_. Same shape, opposite verdict, decided only by the app record.
