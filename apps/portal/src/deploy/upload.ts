import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import type { CspWarning } from "@helix/shared";
import type { PrismaClient, Version as VersionRow } from "../db/client.js";
import type { BlobStore } from "../blob/store.js";
import { isUniqueViolation } from "../db/errors.js";
import { blobPrefixFor } from "../db/mappers.js";
import { AppError } from "../plugins/errors.js";
import { contentTypeFor } from "./mime.js";
import { normalizeEntryPath, validateBundle } from "./validate.js";

export interface SpooledUpload {
  zipPath: string;
  cleanup(): Promise<void>;
}

/** Stream a multipart file to a temp zip so it can be read twice (validate, upload). */
export async function spoolUpload(file: Readable): Promise<SpooledUpload> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "helix-upload-"));
  const zipPath = path.join(dir, "bundle.zip");
  try {
    await pipeline(file, createWriteStream(zipPath));
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    zipPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export interface DeployResult {
  version: VersionRow;
  warnings: CspWarning[];
}

/**
 * Validate a spooled bundle, allocate the next preview version, upload its
 * assets to Blob, and record the deploy. Validation runs to completion before
 * any blob is written (fail closed — a bad bundle never produces partial
 * uploads). Uploads land as `preview`; promotion is a separate step (§5.1).
 */
export async function deployBundle(opts: {
  prisma: PrismaClient;
  blobStore: BlobStore;
  appId: string;
  actor: string;
  zipPath: string;
}): Promise<DeployResult> {
  const { prisma, blobStore, appId, actor, zipPath } = opts;

  const { entries, warnings } = await validateBundle(zipPath);

  const version = await allocateVersion(prisma, appId);
  await uploadEntries(zipPath, blobStore, version.blobPrefix);

  await prisma.auditEvent.create({
    data: {
      appId,
      actor,
      action: "version.upload",
      metadata: {
        number: version.number,
        fileCount: entries.length,
        warningCount: warnings.length,
      },
    },
  });

  return { version, warnings };
}

/**
 * Allocate the next per-app version number. The `@@unique([appId, number])`
 * constraint backstops concurrent deploys; a losing insert retries.
 */
async function allocateVersion(prisma: PrismaClient, appId: string): Promise<VersionRow> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const max = await prisma.version.aggregate({ where: { appId }, _max: { number: true } });
    const number = (max._max.number ?? 0) + 1;
    try {
      return await prisma.version.create({
        data: { appId, number, blobPrefix: blobPrefixFor(appId, number), status: "preview" },
      });
    } catch (err) {
      if (isUniqueViolation(err, "number")) continue;
      throw err;
    }
  }
  throw new AppError("conflict", "could not allocate a version number");
}

/**
 * Second pass over the validated zip: stream each regular-file entry to Blob,
 * one at a time, never overwriting (`createOnly` — versions are immutable).
 */
function uploadEntries(zipPath: string, blobStore: BlobStore, blobPrefix: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(openErr ?? new AppError("internal", "could not re-open bundle for upload"));
        return;
      }

      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(err);
      };

      zipfile.on("error", fail);
      zipfile.on("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });

      zipfile.on("entry", (entry: yauzl.Entry) => {
        const rel = entry.fileName.endsWith("/") ? null : normalizeEntryPath(entry.fileName);
        const contentType = rel ? contentTypeFor(rel) : undefined;
        if (!rel || !contentType) {
          zipfile.readEntry(); // dir entry, or skipped (validation already passed)
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            fail(streamErr ?? new AppError("internal", `could not read ${rel}`));
            return;
          }
          blobStore
            .putObject(`${blobPrefix}${rel}`, stream, { contentType, createOnly: true })
            .then(() => {
              if (!settled) zipfile.readEntry();
            })
            .catch(fail);
        });
      });

      zipfile.readEntry();
    });
  });
}
