// A run is a batch of fetch jobs started together. Its record lives in the
// user's private store under `run:<id>`, and it is written *before* any job is
// submitted: each job's retry key and exact body bytes are saved first. If the
// tab closes halfway through submitting, the next page load (on any device)
// finds jobs with no `jobId` and resubmits them with the same keys, which
// recovers the original jobs instead of creating duplicates.

import {
  NetworkError,
  TERMINAL,
  cancelJob,
  deleteUser,
  getUser,
  jobResult,
  jobStatus,
  listUser,
  putUser,
  submitFetch,
  type JobError,
  type Snapshot,
} from "./api";

export type RunKind = "weather" | "slow" | "lab";

/** What a failure-lab case expects: a terminal status and, if it fails, the code. */
export interface Expectation {
  status: string[];
  code: string | null;
}

export interface RunJob {
  label: string;
  /** The exact submit body, kept as text so a resubmission is byte-identical. */
  body: string;
  key: string;
  jobId: string | null;
  server: string | null;
  status: string;
  progress: string | null;
  error: JobError | null;
  /** A refusal at submission (no job was created), e.g. `payload_invalid`. */
  submitError: string | null;
  /** Set once a successful result has been read, if it was small enough to keep. */
  result?: unknown;
  resultKept?: boolean;
  expect?: Expectation;
  /** Lab only: request cancellation as soon as the job exists. */
  cancel?: boolean;
  cancelSent?: boolean;
  finishedAt?: string;
}

export interface Run {
  id: string;
  kind: RunKind;
  title: string;
  createdAt: string;
  jobs: RunJob[];
}

/** Results bigger than this are shown once but not copied into the run record. */
const KEEP_RESULT_CHARS = 8_000;

export const STATUS_UNSUBMITTED = "unsubmitted";

export function newRun(kind: RunKind, title: string, specs: JobSpec[]): Run {
  const createdAt = new Date().toISOString();
  // Sortable ids: newest-first is a reverse sort on the key.
  const id = `${createdAt.replace(/[-:.TZ]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
  return {
    id,
    kind,
    title,
    createdAt,
    jobs: specs.map((s) => ({
      label: s.label,
      body: JSON.stringify({ url: s.url }),
      key: crypto.randomUUID(),
      jobId: null,
      server: null,
      status: STATUS_UNSUBMITTED,
      progress: null,
      error: null,
      submitError: null,
      ...(s.expect ? { expect: s.expect } : {}),
      ...(s.cancel ? { cancel: true } : {}),
    })),
  };
}

export interface JobSpec {
  label: string;
  url: string;
  expect?: Expectation;
  cancel?: boolean;
}

export function isFinished(job: RunJob): boolean {
  return job.submitError !== null || TERMINAL.has(job.status) || job.status === "gone";
}

export function runFinished(run: Run): boolean {
  return run.jobs.every(isFinished);
}

/** Whether a lab case ended the way it said it would. */
export function matchesExpectation(job: RunJob): boolean | null {
  if (!job.expect || !isFinished(job)) return null;
  if (!job.expect.status.includes(job.status)) return false;
  if (job.status === "succeeded") return true;
  return (job.error?.code ?? null) === job.expect.code;
}

// ---------------------------------------------------------------- storage

const PREFIX = "run:";

export async function saveRun(run: Run): Promise<boolean> {
  const r = await putUser(PREFIX + run.id, run);
  return r.status === 200 || r.status === 201;
}

export async function removeRun(run: Run): Promise<void> {
  await deleteUser(PREFIX + run.id);
}

/** Every run this user has, newest first. */
export async function loadRuns(): Promise<Run[] | "signed-out"> {
  const list = await listUser();
  if (list.status === 401) return "signed-out";
  if (list.status !== 200)
    throw new Error(`listing runs failed: ${list.status} ${list.code ?? ""}`);
  const keys = ((list.body as { keys: { key: string }[] }).keys ?? [])
    .map((k) => k.key)
    .filter((k) => k.startsWith(PREFIX))
    .sort()
    .reverse();
  const runs: Run[] = [];
  for (const key of keys) {
    const r = await getUser(key);
    if (r.status === 200) runs.push((r.body as { value: Run }).value);
  }
  return runs;
}

// ---------------------------------------------------------------- engine

/** The submit codes that mean "not now, same key later". */
const RETRY_LATER = new Set([
  "rate_limited",
  "jobs_capacity_exceeded",
  "jobs_unavailable",
  "jobs_disabled",
]);

export type SubmitOutcome = "submitted" | "refused" | "retry-later" | "signed-out";

/**
 * Submit one job (or recover it, if this key was already accepted). Mutates
 * `job` in place; the caller persists the run.
 */
export async function submitJob(job: RunJob): Promise<SubmitOutcome> {
  let r;
  try {
    r = await submitFetch(job.body, job.key);
  } catch (err) {
    if (err instanceof NetworkError) return "retry-later";
    throw err;
  }
  if (r.status === 202 || r.status === 200) {
    const b = r.body as { server: string; jobId: string; status: string };
    job.server = b.server;
    job.jobId = b.jobId;
    job.status = b.status;
    return "submitted";
  }
  if (r.status === 401) return "signed-out";
  if (r.code !== null && RETRY_LATER.has(r.code)) {
    job.progress = `waiting to submit (${r.code})`;
    return "retry-later";
  }
  job.submitError = r.code ?? `http_${r.status}`;
  return "refused";
}

/**
 * Refresh one submitted job: cancel it if the lab asked for that, read its
 * status, and read its result once it succeeds. Returns whether anything the
 * user can see changed.
 */
export async function refreshJob(job: RunJob): Promise<boolean> {
  if (job.jobId === null || job.server === null || isFinished(job)) return false;
  let changed = false;

  if (job.cancel && !job.cancelSent) {
    const c = await cancelJob(job.server, job.jobId);
    // 202 recorded the request; 409 job_terminal means the job already won.
    if (c.status === 202 || c.status === 409) {
      job.cancelSent = true;
      changed = true;
    }
  }

  const s = await jobStatus(job.server, job.jobId);
  if (s.status === 404) {
    // Unreadable now: the record expired, or the grant or session changed.
    job.status = "gone";
    job.error = { code: "job_not_found", message: "The job record is no longer readable." };
    return true;
  }
  if (s.status !== 200) return changed;
  const snap = s.body as Snapshot;
  const progress = snap.progress
    ? `${snap.progress.step}/${snap.progress.of} ${snap.progress.label}`
    : snap.cancellationRequested
      ? "cancellation requested"
      : null;
  if (snap.status !== job.status || progress !== job.progress) changed = true;
  job.status = snap.status;
  job.progress = progress;
  job.error = snap.error;

  if (snap.status === "succeeded") {
    const r = await jobResult(job.server, job.jobId);
    if (r.status === 200) {
      const text = JSON.stringify(r.body);
      job.resultKept = text.length <= KEEP_RESULT_CHARS;
      job.result = job.resultKept ? r.body : `(${text.length} characters — not kept)`;
    } else if (r.status === 410) {
      job.status = "expired";
    }
  }
  if (isFinished(job)) job.finishedAt = new Date().toISOString();
  return changed || isFinished(job);
}
