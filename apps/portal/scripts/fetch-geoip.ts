import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

/**
 * Download the DB-IP City Lite database for the Visitors view (ADR-0050).
 * The portal image runs this at build time; locally it is optional — without
 * the file, visitor location reports itself unavailable.
 *
 * Usage (from repo root):
 *   pnpm --filter @azx-pbc/portal geo:fetch                    # this month, else last month
 *   pnpm --filter @azx-pbc/portal geo:fetch -- 2026-09         # a specific release
 *   pnpm --filter @azx-pbc/portal geo:fetch -- --out /path/x.mmdb
 *
 * The data is CC-BY 4.0 (https://db-ip.com/db/lite.php). The licence requires
 * the attribution the SPA shows beside the location table.
 */

const DEFAULT_OUT = resolve(import.meta.dirname, "../geo/dbip-city-lite.mmdb");

function months(now = new Date()): string[] {
  const fmt = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [fmt(now), fmt(prev)];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const outFlag = args.indexOf("--out");
  const out = outFlag >= 0 ? resolve(args[outFlag + 1] ?? DEFAULT_OUT) : DEFAULT_OUT;
  const month = args.find((a, i) => /^\d{4}-\d{2}$/.test(a) && args[i - 1] !== "--out");
  const candidates = month ? [month] : months();

  for (const m of candidates) {
    const url = `https://download.db-ip.com/free/dbip-city-lite-${m}.mmdb.gz`;
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      console.warn(`geo:fetch: ${url} → HTTP ${res.status}`);
      continue;
    }
    await mkdir(dirname(out), { recursive: true });
    const tmp = `${out}.partial`;
    await pipeline(Readable.fromWeb(res.body), createGunzip(), createWriteStream(tmp));
    await rename(tmp, out);
    console.log(`geo:fetch: wrote DB-IP City Lite ${m} to ${out}`);
    return;
  }
  throw new Error(`geo:fetch: no DB-IP City Lite release found for ${candidates.join(", ")}`);
}

await main();
