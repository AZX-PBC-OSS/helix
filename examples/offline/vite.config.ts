import { defineConfig } from "vite";

/**
 * This app is served from a **path prefix** (`/app/`), not the domain root,
 * because its service-worker scope is confined there (ADR-0035). Two settings
 * follow from that, and they are the whole reason this config differs from
 * every other example:
 *
 *  - `base: "./"` keeps built asset URLs relative, so they resolve under
 *    whatever prefix the edge serves the document from.
 *  - `outDir: "dist/app"` nests the bundle. The edge maps a URL path
 *    **literally** onto a blob key, so a request for `/app/main.js` reads
 *    `<version-prefix>app/main.js` — the zip must actually contain an `app/`
 *    directory. Setting `base` alone is the classic mistake here: the URLs come
 *    out right and every one of them 404s.
 *
 * `emptyOutDir` only clears `dist/app`, so the root redirect that
 * `scripts/emit-root-redirect.mjs` writes to `dist/index.html` survives a
 * rebuild.
 */
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist/app",
  },
});
