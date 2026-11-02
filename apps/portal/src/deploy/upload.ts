import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import type { CspWarning, DeployReport } from "@azx-pbc/shared";
import type { PrismaClient, Version as VersionRow } from "../db/client.js";
import type { BlobStore } from "../blob/store.js";
import { isUniqueViolation } from "../db/errors.js";
import { blobPrefixFor } from "../db/mappers.js";
import { AppError } from "../plugins/errors.js";
import { contentTypeFor } from "./mime.js";
import { normalizeEntryPath, validateBundle } from "./validate.js";
import {
  ATTR_APP_ID,
  ATTR_DEPLOY_FILE_COUNT,
  ATTR_DEPLOY_WARNING_COUNT,
  SPAN_DEPLOY_ALLOCATE,
  SPAN_DEPLOY_BUNDLE,
  SPAN_DEPLOY_RECORD,
  SPAN_DEPLOY_UPLOAD,
  SPAN_DEPLOY_VALIDATE,
} from "@azx-pbc/shared/telemetry";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { inChildSpan, tracer } from "../telemetry.js";

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

/**
 * Verified CI provenance (ADR-0051), from the GitHub Actions token that
 * authenticated the upload. Written onto the version row; `tokenJti` is unique
 * there, which is what makes a token single-use.
 */
export interface VersionSourceInput {
  provider: "github";
  repositoryId: string;
  repoFullName: string;
  ref: string;
  commitSha: string;
  workflowRef: string;
  runId: string;
  runAttempt: number;
  actor: string;
  tokenJti: string;
}

/** The token's `jti` already produced a version (ADR-0051 decision 8). */
export function replayedTokenError(): AppError {
  return new AppError("conflict", "this token has already deployed a version", {
    reason: "replayed",
  });
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
  /** Client-asserted salvage provenance (ADR-0038); stored as-is, never trusted. */
  deployReport?: DeployReport;
  /** Verified CI provenance (ADR-0051); absent on non-CI uploads. */
  source?: VersionSourceInput;
}): Promise<DeployResult> {
  const { prisma, blobStore, appId, actor, zipPath, deployReport, source } = opts;

  return tracer.startActiveSpan(
    SPAN_DEPLOY_BUNDLE,
    { attributes: { [ATTR_APP_ID]: appId } },
    async (span) => {
      try {
        return await runDeploy(span);
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    },
  );

  /**
   * The deploy path's phases as child spans (ADR-0037 decision 4).
   *
   * This is the control plane, so the interesting signal is *shape* rather than
   * rate: a deploy that got slow is almost always slow in exactly one phase,
   * and the whole point of instrumenting a multi-second operation is being able
   * to say which. So **every** phase gets one — validate, allocate, upload and
   * record. An untraced phase is invisible in the flame graph but still counted
   * in the parent's duration, which reads as unexplained overhead and is worse
   * than a span nobody looks at.
   *
   * No metric here — the deploy rate is low enough that a counter would answer
   * nothing a span search does not. The CI route's authentication decisions are
   * counted separately (`helix.deploy.repo_requests`, ADR-0051).
   *
   * Allocation precedes the blob upload, so a bundle that fails validation never
   * writes a version row and never spends a CI token's `jti`. A failure after
   * allocation does spend it; a re-run of the job gets a fresh token.
   */
  async function runDeploy(parentSpan: Span): Promise<DeployResult> {
    const { entries, warnings } = await inChildSpan(SPAN_DEPLOY_VALIDATE, () =>
      validateBundle(zipPath),
    );
    parentSpan.setAttributes({
      [ATTR_DEPLOY_FILE_COUNT]: entries.length,
      [ATTR_DEPLOY_WARNING_COUNT]: warnings.length,
    });

    const version = await inChildSpan(SPAN_DEPLOY_ALLOCATE, () =>
      allocateVersion(prisma, appId, deployReport, source),
    );
    await inChildSpan(SPAN_DEPLOY_UPLOAD, () =>
      uploadEntries(zipPath, blobStore, version.blobPrefix),
    );

    await inChildSpan(SPAN_DEPLOY_RECORD, () =>
      prisma.auditEvent.create({
        data: {
          appId,
          actor,
          action: "version.upload",
          metadata: {
            number: version.number,
            fileCount: entries.length,
            warningCount: warnings.length,
            ...(deployReport ? { salvageOutcome: deployReport.outcome } : {}),
            ...(source
              ? {
                  source: {
                    provider: source.provider,
                    repositoryId: source.repositoryId,
                    sha: source.commitSha,
                    runId: source.runId,
                    runAttempt: source.runAttempt,
                    githubActor: source.actor,
                  },
                }
              : {}),
          },
        },
      }),
    );

    return { version, warnings };
  }
}

/**
 * Allocate the next per-app version number. The `@@unique([appId, number])`
 * constraint backstops concurrent deploys; a losing insert retries. The unique
 * `sourceTokenJti` backstops two concurrent requests with the same CI token,
 * which the route's replay pre-check cannot see; that loser is refused, not
 * retried.
 */
async function allocateVersion(
  prisma: PrismaClient,
  appId: string,
  deployReport?: DeployReport,
  source?: VersionSourceInput,
): Promise<VersionRow> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const max = await prisma.version.aggregate({ where: { appId }, _max: { number: true } });
    const number = (max._max.number ?? 0) + 1;
    try {
      return await prisma.version.create({
        data: {
          appId,
          number,
          blobPrefix: blobPrefixFor(appId, number),
          status: "preview",
          deployReport: deployReport ?? undefined,
          ...(source
            ? {
                sourceProvider: source.provider,
                sourceRepositoryId: source.repositoryId,
                sourceRepoFullName: source.repoFullName,
                sourceRef: source.ref,
                sourceCommitSha: source.commitSha,
                sourceWorkflowRef: source.workflowRef,
                sourceRunId: source.runId,
                sourceRunAttempt: source.runAttempt,
                sourceActor: source.actor,
                sourceTokenJti: source.tokenJti,
              }
            : {}),
        },
      });
    } catch (err) {
      if (source && isUniqueViolation(err, "sourceTokenJti")) throw replayedTokenError();
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
