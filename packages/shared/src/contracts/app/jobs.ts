// Contracts for the edge's /_api/jobs routes (ADR-0054).
import { z } from "zod";
import { ApiErrorSchema } from "../../api.js";
import {
  FetchJobInputSchema,
  IDEMPOTENCY_KEY_HEADER,
  JOBS_MAX_INPUT_BYTES,
  JobAcceptedSchema,
  JobCancellationAcceptedSchema,
  JobRequestErrorSchema,
  JobSnapshotSchema,
} from "../../jobs.js";
import { json, jsonResponse, media, type ResponseSpec } from "../define.js";
import { appRoute } from "./common.js";

const tags = ["Background jobs"] as const;

function jobsError(description: string): ResponseSpec {
  return jsonResponse(JobRequestErrorSchema, description);
}

const JOBS =
  "Background jobs run platform-owned job types for the app, asynchronously. Only a " +
  "signed-in user may submit or read jobs; anonymous visitors and shared-password sessions " +
  "are refused with 403 `forbidden`, and a job is visible only to the user who submitted it.";

const FORWARDED =
  "Refusals the jobs service makes are forwarded with their own status and a " +
  "`JobRequestError` body; the statuses below list the ones a caller should expect.";

const serverParam = z.string().meta({ description: "The job server, `jobs` on this platform." });
const jobIdParam = z
  .string()
  .meta({ description: "The `jobId` from the submission's acceptance. 1–128 characters." });

const referenceParams = z.object({ server: serverParam, jobId: jobIdParam });

const origin = z
  .string()
  .optional()
  .meta({ description: "Must be the app's own origin (CSRF check). Browsers send it." });

/**
 * The session gate's 401, or the jobs service's own `unauthorized` forwarded
 * when it refused the edge's signed request. The gate's envelope is not
 * normalized into the jobs shape.
 */
const unauthorized = jsonResponse(
  z.union([ApiErrorSchema, JobRequestErrorSchema]),
  "The jobs service refused the platform's own signed request (a `JobRequestError` with " +
    "`unauthorized`), which is a platform fault, not the caller's.",
);

const jobsDisabled = jobsError(
  "Background jobs are not enabled on this deployment (`jobs_disabled`), or the jobs service " +
    "did not answer usefully (`jobs_unavailable`). Retry `jobs_unavailable`; a submission's " +
    "outcome is then unknown.",
);

export const submitJob = appRoute({
  id: "submitJob",
  method: "POST",
  path: "/_api/jobs/:server/types/:type",
  tags,
  summary: "Submit a job",
  description:
    `${JOBS}\n\nThe body is the job's input, forwarded byte for byte. Send an ` +
    "`Idempotency-Key` to make a retry safe: a repeat with the same key and input returns " +
    "the original job. Submissions are charged against the app's submission budget whatever " +
    "their outcome. The request must carry the app's own `Origin` (CSRF check).\n\n" +
    FORWARDED,
  params: z.object({
    server: serverParam,
    type: z.string().meta({
      description:
        "The job type within the server, e.g. `fetch`. The app's manifest must grant it.",
    }),
  }),
  headers: z.object({
    origin,
    [IDEMPOTENCY_KEY_HEADER]: z.string().optional().meta({
      description: "An optional retry key, at most 128 bytes, not empty or whitespace.",
    }),
  }),
  body: {
    required: true,
    description:
      `The job input as JSON, at most ${JOBS_MAX_INPUT_BYTES} bytes. Its shape depends on the ` +
      "type; the schema below is the `jobs:fetch` input.",
    content: media("application/json", undefined, FetchJobInputSchema.out),
  },
  responses: {
    202: jsonResponse(
      JobAcceptedSchema,
      "The job was accepted, or this is a keyed replay of an accepted job. Poll the snapshot.",
    ),
    400: jobsError(
      "No job server has this name (`job_server_unknown`), the `Idempotency-Key` is invalid " +
        "(`idempotency_key_invalid`), or the input is not valid for the type (`payload_invalid`).",
    ),
    403: jobsError(
      "The caller may not use jobs, the `Origin` is not the app's own, or the app's manifest " +
        "does not grant this type (`forbidden`).",
    ),
    409: jobsError(
      "The `Idempotency-Key` was already used with different input (`idempotency_conflict`, " +
        "with the existing job's `status` and `error`).",
    ),
    413: jobsError("The input exceeds the size limit (`payload_too_large`)."),
    429: jobsError(
      "The app's submission budget is exhausted (`rate_limited`), or the jobs service has no " +
        "capacity (`jobs_capacity_exceeded`).",
    ),
    401: unauthorized,
    503: jobsDisabled,
  },
});

export const getJob = appRoute({
  id: "getJob",
  method: "GET",
  path: "/_api/jobs/:server/:jobId",
  tags,
  summary: "Read a job's state",
  description: `${JOBS}\n\nThe complete latest state of the job: poll this until \`status\` is terminal.\n\n${FORWARDED}`,
  params: referenceParams,
  responses: {
    200: jsonResponse(JobSnapshotSchema, "The job's state."),
    403: jobsError(
      "The caller may not use jobs, or the job's type is no longer granted (`forbidden`).",
    ),
    404: jobsError("No job matches this reference for this caller (`job_not_found`)."),
    401: unauthorized,
    503: jobsDisabled,
  },
});

export const getJobResult = appRoute({
  id: "getJobResult",
  method: "GET",
  path: "/_api/jobs/:server/:jobId/result",
  tags,
  summary: "Read a finished job's result",
  description: `${JOBS}\n\nThe result of a succeeded job, until it expires.\n\n${FORWARDED}`,
  params: referenceParams,
  responses: {
    200: {
      description: "The job's result: any JSON value, `null` included, as the job produced it.",
      content: json(z.unknown(), "The raw JSON result. For `jobs:fetch`, see `FetchJobResult`."),
    },
    403: jobsError(
      "The caller may not use jobs, or the job's type is no longer granted (`forbidden`).",
    ),
    404: jobsError("No job matches this reference for this caller (`job_not_found`)."),
    409: jobsError(
      "The job has not finished (`job_not_ready`), or finished without a result " +
        "(`job_terminal`), with the job's `status` and `error`.",
    ),
    410: jobsError("The result has expired (`result_expired`)."),
    401: unauthorized,
    503: jobsDisabled,
  },
});

export const cancelJob = appRoute({
  id: "cancelJob",
  method: "DELETE",
  path: "/_api/jobs/:server/:jobId",
  tags,
  summary: "Request a job's cancellation",
  description:
    `${JOBS}\n\nRecords the request durably; the job may still finish first. The request ` +
    `must carry the app's own \`Origin\` (CSRF check).\n\n${FORWARDED}`,
  params: referenceParams,
  headers: z.object({ origin }),
  responses: {
    202: jsonResponse(JobCancellationAcceptedSchema, "The cancellation request was recorded."),
    403: jobsError(
      "The caller may not use jobs, the `Origin` is not the app's own, or the job's type is " +
        "no longer granted (`forbidden`).",
    ),
    404: jobsError("No job matches this reference for this caller (`job_not_found`)."),
    409: jobsError("The job has already finished (`job_terminal`, with its `status` and `error`)."),
    401: unauthorized,
    503: jobsDisabled,
  },
});

export const jobsContracts = [submitJob, getJob, getJobResult, cancelJob] as const;
