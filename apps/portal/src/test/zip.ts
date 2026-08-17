import { type Archiver, ZipArchive } from "archiver";
import { createWriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ZipFileSpec {
  name: string;
  content?: Buffer | string;
  /** When set, the entry is a symlink pointing here (for security tests). */
  symlinkTo?: string;
  /**
   * When set, the entry is a directory record (`name` gets a trailing slash if
   * it lacks one). Some archivers emit these and some don't — which is itself a
   * difference the malformed-bundle fixtures reproduce.
   */
  directory?: boolean;
  mode?: number;
}

export interface ZipBuildOptions {
  /**
   * Skip deflate and store entries verbatim. Deflating at level 9 dominates the
   * cost of a many-thousand-entry fixture (~5x the archive time for 20k tiny
   * files), and no assertion here depends on the compressed size — so bulk
   * fixtures build stored and leave the timing budget to the code under test.
   */
  store?: boolean;
}

function appendSpecs(archive: Archiver, specs: ZipFileSpec[]): void {
  for (const spec of specs) {
    if (spec.symlinkTo !== undefined) {
      archive.symlink(spec.name, spec.symlinkTo);
    } else if (spec.directory) {
      // Archiver reads the type off the trailing slash, so an empty payload
      // under a `dir/` name is the directory record — not a zero-byte file.
      const name = spec.name.endsWith("/") ? spec.name : `${spec.name}/`;
      archive.append(Buffer.alloc(0), { name, mode: spec.mode });
    } else {
      archive.append(spec.content ?? "", { name: spec.name, mode: spec.mode });
    }
  }
}

/** Build a bundle zip on disk and return its path (in a fresh temp dir). */
export async function buildZipFile(
  specs: ZipFileSpec[],
  options: ZipBuildOptions = {},
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "helix-zip-"));
  const zipPath = path.join(dir, "bundle.zip");
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(zipPath);
    const archive = archiveFor(options);
    out.on("close", () => resolve());
    out.on("error", reject);
    archive.on("error", reject);
    archive.pipe(out);
    appendSpecs(archive, specs);
    void archive.finalize();
  });
  return zipPath;
}

/** Build a bundle zip entirely in memory and return its bytes. */
export function buildZipBuffer(
  specs: ZipFileSpec[],
  options: ZipBuildOptions = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = archiveFor(options);
    archive.on("data", (c: Buffer) => chunks.push(c));
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    appendSpecs(archive, specs);
    void archive.finalize();
  });
}

function archiveFor({ store = false }: ZipBuildOptions): ZipArchive {
  return store ? new ZipArchive({ store: true }) : new ZipArchive({ zlib: { level: 9 } });
}
