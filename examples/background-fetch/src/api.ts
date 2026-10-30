// Thin clients for the two gateway surfaces this app uses: background jobs
// (`/_api/jobs/*`) and the signed-in user's private store (`/_api/data/user/*`).
// Every call is same-origin and relative, so the bundle works on any app host.

/** The fetch job's server and type: `jobs:fetch` in the manifest. */
const SUBMIT_PATH = "/_api/jobs/jobs/types/fetch";

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "crashed"
  | "cancelled"
  | "expired";

export const TERMINAL: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "crashed",
  "cancelled",
  "expired",
]);

export interface JobError {
  code: string;
  message: string;
}

export interface Snapshot {
  server: string;
  jobId: string;
  type: string;
  status: JobStatus;
  attempt: number | null;
  progress: { step: number; of: number; label: string } | null;
  cancellationRequested: boolean;
  resultExpiresAt: string | null;
  recordExpiresAt: string | null;
  error: JobError | null;
}

/** One line of the exchange log: what the browser sent and what came back. */
export interface Exchange {
  at: Date;
  method: string;
  path: string;
  status: number | "network";
  code?: string;
  note?: string;
}

type Listener = (e: Exchange) => void;
const listeners: Listener[] = [];
export function onExchange(fn: Listener): void {
  listeners.push(fn);
}
function record(e: Exchange): void {
  for (const fn of listeners) fn(e);
}

/**
 * A response reduced to what callers branch on. `code` comes from either error
 * shape: jobs errors are flat (`{code}`), session and data errors are nested
 * (`{error: {code}}`). A non-JSON body (an HTML error page) leaves `body` null.
 */
export interface Reply {
  status: number;
  code: string | null;
  body: unknown;
  etag: string | null;
}

/** A network failure, distinct from any HTTP answer. */
export class NetworkError extends Error {}

async function call(method: string, path: string, init: RequestInit = {}): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      method,
      headers: { accept: "application/json", ...init.headers },
    });
  } catch (err) {
    record({ at: new Date(), method, path, status: "network" });
    throw new NetworkError(err instanceof Error ? err.message : String(err));
  }
  let body: unknown = null;
  if (res.headers.get("content-type")?.includes("application/json")) {
    body = await res.json().catch(() => null);
  }
  const code = errorCode(body);
  record({ at: new Date(), method, path, status: res.status, ...(code ? { code } : {}) });
  return { status: res.status, code, body, etag: res.headers.get("etag") };
}

function errorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { code?: unknown; error?: unknown };
  if (typeof b.code === "string") return b.code;
  if (typeof b.error === "object" && b.error !== null) {
    const nested = (b.error as { code?: unknown }).code;
    if (typeof nested === "string") return nested;
  }
  return null;
}

// ---------------------------------------------------------------- jobs

/**
 * Submit a fetch job. `bodyText` is sent byte for byte: a retry with the same
 * key must carry exactly the same bytes, so callers keep the string, not an
 * object they serialize again.
 */
export function submitFetch(bodyText: string, idempotencyKey: string): Promise<Reply> {
  return call("POST", SUBMIT_PATH, {
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: bodyText,
  });
}

export function jobStatus(server: string, jobId: string): Promise<Reply> {
  return call("GET", `/_api/jobs/${server}/${jobId}`);
}

export function jobResult(server: string, jobId: string): Promise<Reply> {
  return call("GET", `/_api/jobs/${server}/${jobId}/result`);
}

export function cancelJob(server: string, jobId: string): Promise<Reply> {
  return call("DELETE", `/_api/jobs/${server}/${jobId}`);
}

// ---------------------------------------------------------------- user data

export function putUser(key: string, value: unknown): Promise<Reply> {
  return call("PUT", `/_api/data/user/${encodeURIComponent(key)}`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

export function getUser(key: string): Promise<Reply> {
  return call("GET", `/_api/data/user/${encodeURIComponent(key)}`);
}

export function deleteUser(key: string): Promise<Reply> {
  return call("DELETE", `/_api/data/user/${encodeURIComponent(key)}`);
}

export function listUser(): Promise<Reply> {
  return call("GET", "/_api/data/user");
}

export function whoami(): Promise<Reply> {
  return call("GET", "/_api/me");
}
