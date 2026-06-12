import path from "node:path";
import yauzl from "yauzl";
import type { CspWarning } from "@helix/shared";
import { AppError } from "../plugins/errors.js";
import { contentTypeFor, isLintable } from "./mime.js";
import { lintForCsp } from "./csp-lint.js";
import {
  MAX_COMPRESSION_RATIO,
  MAX_ENTRIES,
  MAX_FILE_BYTES,
  MAX_LINT_BYTES,
  MAX_TOTAL_BYTES,
} from "./limits.js";

export interface ValidatedEntry {
  /** Normalized, bundle-relative posix path. */
  path: string;
  uncompressedSize: number;
  contentType: string;
}

export interface ValidationResult {
  entries: ValidatedEntry[];
  totalBytes: number;
  /** Non-blocking advisories (CSP origins, missing index.html). */
  warnings: CspWarning[];
}

function bundleInvalid(message: string): AppError {
  return new AppError("bundle_invalid", message);
}

/**
 * Reject a zip-entry path that could escape the bundle root (zip-slip) or name
 * a non-relative location. Returns the normalized relative path, or null if
 * unsafe.
 */
export function normalizeEntryPath(name: string): string | null {
  if (name.includes("\0") || name.includes("\\")) return null; // null byte / windows separator
  if (name.startsWith("/")) return null; // absolute
  if (/^[a-zA-Z]:/.test(name)) return null; // drive letter
  const trimmed = name.replace(/\/+$/, "");
  if (trimmed === "") return null;
  const norm = path.posix.normalize(trimmed);
  if (norm.startsWith("/") || norm === ".." || norm.startsWith("../")) return null;
  if (norm.split("/").some((seg) => seg === "..")) return null;
  return norm;
}

/**
 * Validate a bundle zip on disk: reject path traversal, symlinks/special files,
 * disallowed file types, and oversized/decompression-bomb archives. Reads each
 * entry's actual decompressed bytes (never trusting header sizes) and aborts a
 * stream the moment it exceeds the remaining budget.
 */
export function validateBundle(zipPath: string): Promise<ValidationResult> {
  return new Promise<ValidationResult>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(openErr ?? bundleInvalid("could not open bundle as a zip archive"));
        return;
      }

      const entries: ValidatedEntry[] = [];
      const lintFiles: { path: string; text: string }[] = [];
      let totalBytes = 0;
      let entryCount = 0;
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
        resolve({ entries, totalBytes, warnings: buildWarnings(entries, lintFiles) });
      });

      zipfile.on("entry", (entry: yauzl.Entry) => {
        handleEntry(entry)
          .then(() => {
            if (!settled) zipfile.readEntry();
          })
          .catch(fail);
      });

      async function handleEntry(entry: yauzl.Entry): Promise<void> {
        const isDir = entry.fileName.endsWith("/");
        const rel = normalizeEntryPath(entry.fileName);
        if (rel === null) {
          throw bundleInvalid(`unsafe path in bundle: ${entry.fileName}`);
        }
        if (isDir) return; // directory entry: path checked, nothing to store

        // Reject symlinks / special files via the unix mode in the high bits.
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) {
          throw bundleInvalid(`symlinks are not allowed: ${rel}`);
        }

        const contentType = contentTypeFor(rel);
        if (!contentType) {
          throw bundleInvalid(`file type not allowed (static files only): ${rel}`);
        }

        if (++entryCount > MAX_ENTRIES) {
          throw bundleInvalid(`too many files in bundle (limit ${MAX_ENTRIES})`);
        }

        const { bytes, overflow, text } = await drainEntry(
          zipfile,
          entry,
          totalBytes,
          isLintable(rel),
        );
        if (overflow) {
          throw bundleInvalid(`bundle exceeds size limits (at ${rel})`);
        }
        if (entry.compressedSize > 0 && bytes / entry.compressedSize > MAX_COMPRESSION_RATIO) {
          throw bundleInvalid(`suspicious compression ratio for ${rel}`);
        }

        totalBytes += bytes;
        entries.push({ path: rel, uncompressedSize: bytes, contentType });
        if (text !== undefined) lintFiles.push({ path: rel, text });
      }

      zipfile.readEntry();
    });
  });
}

function buildWarnings(
  entries: ValidatedEntry[],
  lintFiles: { path: string; text: string }[],
): CspWarning[] {
  const warnings = lintForCsp(lintFiles);
  if (!entries.some((e) => e.path === "index.html")) {
    warnings.push({
      file: "index.html",
      origin: "(none)",
      hint: "bundle has no index.html at its root; the app may not serve a default page",
    });
  }
  return warnings;
}

/**
 * Stream one entry, counting actual decompressed bytes and aborting as soon as
 * the file or the remaining total budget is exceeded. Optionally buffers up to
 * MAX_LINT_BYTES of text for the CSP lint.
 */
function drainEntry(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  totalSoFar: number,
  capture: boolean,
): Promise<{ bytes: number; overflow: boolean; text?: string }> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? bundleInvalid(`could not read ${entry.fileName}`));
        return;
      }

      // Abort at whichever bites first: this file's cap or the remaining total.
      const limit = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - totalSoFar);
      let bytes = 0;
      let overflow = false;
      let captured = 0;
      let settled = false;
      const chunks: Buffer[] = [];

      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({
          bytes,
          overflow,
          text: capture ? Buffer.concat(chunks).toString("utf8") : undefined,
        });
      };

      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (capture && captured < MAX_LINT_BYTES) {
          const take = Math.min(chunk.length, MAX_LINT_BYTES - captured);
          chunks.push(chunk.subarray(0, take));
          captured += take;
        }
        if (bytes > limit) {
          overflow = true;
          stream.destroy();
        }
      });
      stream.on("error", (e: Error) => {
        if (overflow)
          finish(); // premature-close from our destroy() — expected
        else if (!settled) {
          settled = true;
          reject(e);
        }
      });
      stream.on("close", finish);
    });
  });
}
