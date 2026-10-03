import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

/**
 * Download the DB-IP City Lite database for the Visitors view (ADR-0050).
 *
 * The portal image runs this in its own build stage with plain `node` (Node 24
 * strips the types), so it imports nothing outside `node:*`. The dev
 * container's post-create runs it too. Without the file, visitor location
 * reports itself unavailable.
 *
 * Usage (from repo root):
 *   pnpm --filter @azx-pbc/portal geo:fetch                    # this month, else last month
 *   pnpm --filter @azx-pbc/portal geo:fetch -- 2026-09         # one pinned release
 *   pnpm --filter @azx-pbc/portal geo:fetch -- --out /path/x.mmdb
 *
 * The data is CC-BY 4.0 (https://db-ip.com/db/lite.php). The licence requires
 * the attribution the SPA shows beside the location table.
 */

const DEFAULT_OUT = resolve(import.meta.dirname, "../../geo/dbip-city-lite.mmdb");

/** The MMDB metadata section starts with this marker, near the end of the file. */
const METADATA_MARKER = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from("MaxMind.com")]);
/** The format caps the metadata section at 128 KiB. */
const METADATA_SEARCH_BYTES = 128 * 1024;

export interface FetchArgs {
  out: string;
  /** A pinned `YYYY-MM` release, or null for this month then last month. */
  month: string | null;
}

export function parseArgs(argv: string[], defaultOut = DEFAULT_OUT): FetchArgs {
  const args = argv.filter((a) => a !== "--");
  let out = defaultOut;
  let month: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("geo:fetch: --out needs a file path");
      }
      out = resolve(value);
      i++;
    } else if (arg !== undefined && /^\d{4}-\d{2}$/.test(arg)) {
      month = arg;
    } else {
      throw new Error(`geo:fetch: unrecognised argument "${arg}"`);
    }
  }
  return { out, month };
}

/** This month and last month, UTC, newest first. */
export function candidateMonths(now = new Date()): string[] {
  const fmt = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [fmt(now), fmt(prev)];
}

/**
 * True when the file ends in an MMDB metadata section. A truncated download
 * that still gunzipped cleanly fails this, so it never replaces a good file.
 */
export async function looksLikeMmdb(path: string): Promise<boolean> {
  const { size } = await stat(path);
  const length = Math.min(size, METADATA_SEARCH_BYTES);
  const handle = await open(path, "r");
  try {
    const tail = Buffer.alloc(length);
    await handle.read(tail, 0, length, size - length);
    return tail.lastIndexOf(METADATA_MARKER) !== -1;
  } finally {
    await handle.close();
  }
}

export async function fetchGeoDb(args: FetchArgs): Promise<string> {
  const months = args.month ? [args.month] : candidateMonths();
  await mkdir(dirname(args.out), { recursive: true });
  const tmp = `${args.out}.partial`;
  for (const m of months) {
    const url = `https://download.db-ip.com/free/dbip-city-lite-${m}.mmdb.gz`;
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) {
        console.warn(`geo:fetch: ${url} → HTTP ${res.status}`);
        continue;
      }
      await pipeline(Readable.fromWeb(res.body), createGunzip(), createWriteStream(tmp));
      if (!(await looksLikeMmdb(tmp))) {
        console.warn(`geo:fetch: ${url} did not produce a valid MMDB file`);
        continue;
      }
      await rename(tmp, args.out);
      return m;
    } catch (err) {
      console.warn(`geo:fetch: ${url} failed: ${String(err)}`);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  throw new Error(`geo:fetch: no usable DB-IP City Lite release for ${months.join(", ")}`);
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const month = await fetchGeoDb(args);
  console.log(`geo:fetch: wrote DB-IP City Lite ${month} to ${args.out}`);
}
