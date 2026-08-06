import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Write `dist/index.html` — a bare-domain redirect into the app's scope.
 *
 * The platform deliberately does **not** redirect `/` to an offline app's scope
 * prefix (ADR-0035): doing so would make the edge care about an app's internal
 * layout and become a compatibility surface for apps that legitimately want a
 * landing page at the root. So `/` on a scoped app 404s unless the app ships
 * something there, and this is that something — the two lines the ADR tells you
 * to write.
 *
 * Note what it does *not* fix: offline, `/` is outside the worker's scope, so a
 * cold bare-domain visit reaches neither the worker nor the edge. Installing the
 * PWA (whose `start_url` is `/app/`) is the answer to that, not this file.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "dist", "index.html");

const html = `<!doctype html>
<meta charset="utf-8" />
<title>Offline demo · AZX</title>
<meta http-equiv="refresh" content="0; url=./app/" />
<a href="./app/">Continue to the app →</a>
`;

await mkdir(dirname(out), { recursive: true });
await writeFile(out, html, "utf8");
console.log(`wrote ${out}`);
