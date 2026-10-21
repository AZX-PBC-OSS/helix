---
title: Background jobs
description: "Start platform-provided work that keeps running after the page closes, then poll for its progress and result. Covers the grant, the four operations, keyed retries, cancellation, failures, and retention."
---

# Background jobs

A background job is work the platform runs for your app after the request
that started it has ended. The user can close the tab, lose the network, or
sign in again, and the job keeps running. Your app polls for the job's state
and reads the result when it is done.

Jobs run platform-provided code only. Your app chooses a job type from the
deployment's catalogue and sends that type's input. It cannot upload or run
its own server code. The one production job type is the **outbound fetch
job**, `jobs:fetch`: one governed `GET` of a URL, kept as a JSON result.

Use a job when the work must survive the page. For a call that can finish
while the user waits, the [fetch proxy](/apps/gateway#calling-external-apis)
is simpler.

## Before you start

You need three things.

**A jobs grant.** In the portal's Capabilities tab, the **Background jobs**
card lists the job types this deployment offers. Select **Outbound fetch job**
and save. Adding a job type applies immediately; it does not need an
administrator's approval. In the [manifest](/apps/manifest) the grant looks
like this:

```ts
jobs: { types: ["jobs:fetch"] }
```

A type is always written as `<server>:<type>`. The grant matches that exact
string: there is no wildcard and no default server. If the card cannot load
the catalogue, it says so and offers **Retry**; your saved selection is not
changed. A saved type that the deployment no longer offers stays visible,
marked "not offered on this deployment", and you can still remove it.

**Fetch permissions for the target.** The fetch job uses the app's existing
fetch settings. Add the target origin under **Fetch proxy** (`fetch.origins`).
A new origin goes to an administrator for approval. Origins without
credentials and origins with a stored secret both work. An origin that uses a
delegated user connection does not, because no user is present when the job
runs. The job also counts against the app's `fetch.requestsPerDay` budget.

**A signed-in user or a dev token.** Jobs belong to the person who started
them. Only a signed-in user on the app's host, or a developer using a dev
token on the dev gateway, can use jobs. Anonymous visitors on a `public` app
and shared-password visitors get `403 forbidden`.

## The four operations

All four are on your app's own origin, under `/_api/jobs/`.

| Operation | Request | Success |
| --- | --- | --- |
| Submit | `POST /_api/jobs/:server/types/:type` | `202` with the job reference |
| Read status | `GET /_api/jobs/:server/:jobId` | `200` with a snapshot |
| Read the result | `GET /_api/jobs/:server/:jobId/result` | `200` with the result JSON |
| Cancel | `DELETE /_api/jobs/:server/:jobId` | `202` with a cancellation acknowledgement |

For the fetch job, `:server` is `jobs` and `:type` is `fetch`, so you submit
to `/_api/jobs/jobs/types/fetch`. Every jobs response, success or error, is
sent with `Cache-Control: no-store`.

### Submit

The request body is the job's input. For `jobs:fetch` it is an object with
one field, an absolute `http` or `https` URL:

```json
{ "url": "https://api.example.com/reports/42" }
```

There is no method, header, connection, or retry setting to choose, and any
other field is refused. The body can be at most 64 KiB (65,536 bytes).

The response tells you which job was created:

```json
{ "server": "jobs", "jobId": "8f14e45f-ceea-467f-a0e4-6a2b0e1c1c3d", "status": "queued" }
```

Store both `server` and `jobId`. A job id is only unique on its own server,
so the pair is the reference. A `202` means the job is durably stored. It
does not mean the job has started or succeeded, and the status may already
be terminal when the reply arrives.

### Read status

A status read returns the job's complete current state. Every field is
always present; a value that does not apply is `null`.

```json
{
  "server": "jobs",
  "jobId": "8f14e45f-ceea-467f-a0e4-6a2b0e1c1c3d",
  "type": "jobs:fetch",
  "status": "succeeded",
  "attempt": 1,
  "progress": { "step": 1, "of": 1, "label": "fetched" },
  "cancellationRequested": false,
  "resultExpiresAt": "2026-10-28T09:15:02.000Z",
  "recordExpiresAt": "2026-11-20T09:15:02.000Z",
  "error": null
}
```

- `attempt` is the number of the execution attempt the snapshot describes.
  It is `null` until an attempt starts.
- `progress` is `{step, of, label}`, where `step` is between 0 and `of`, and
  `label` is short text written by the platform. It is `null` before an
  attempt reports progress. The fetch job has one unit of work and reports
  it complete only when it has a valid JSON result.
- `cancellationRequested` is `true` once a cancellation has been recorded.
  It does not mean the job has stopped.
- `recordExpiresAt` is set once the job reaches a terminal status, and
  `resultExpiresAt` is set only for a job that succeeded. See
  [retention](#how-long-jobs-are-kept).
- `error` explains a failure. It is a fixed `{code, message}` pair: branch on
  `code`, never on `message`.

Each read returns the latest state. There is no event stream and no cursor,
so you can miss intermediate progress between polls. That is expected.

### Read the result

A successful result is the JSON value the job produced, sent as the whole
response body. For the fetch job, that is the JSON value the target returned.
The upstream status and headers are not included. JSON `null` is a valid result,
so check the HTTP status rather than the value.

If the job has not finished, the read answers `409 job_not_ready`. If it
finished without a result, the read answers `409 job_terminal`. Both bodies
include the job's `status` and `error`. After the result expires, the read
answers `410 result_expired`.

### Cancel

`DELETE` records a request to stop the job. The `202` reply confirms that the
request was recorded, not that the job has stopped:

```json
{ "server": "jobs", "jobId": "8f14e45f-ceea-467f-a0e4-6a2b0e1c1c3d", "cancellationRequested": true }
```

Keep polling until the job reaches a terminal status. See
[Cancellation](#cancellation) for what can happen in between.

## Statuses

| Status | Meaning |
| --- | --- |
| `queued` | Waiting to run. Also used while a failed attempt waits to be retried. |
| `running` | An attempt is executing. |
| `succeeded` | Finished with a result. |
| `failed` | The job reported a failure. `error.code` says why. |
| `crashed` | Execution was lost to a platform interruption and no attempt is left. |
| `cancelled` | Stopped by a cancellation or by the app being archived. |
| `expired` | A successful job whose result is no longer readable. |

`succeeded`, `failed`, `crashed`, `cancelled`, and `expired` are terminal: a
job never leaves them. `expired` applies only to jobs that succeeded. A job
that runs out of time is `failed` with the `timeout` code.

## Why a job failed

A failed, crashed, or cancelled job's `error.code` is one of these:

| Code | Meaning |
| --- | --- |
| `execution_input_invalid` | The input was accepted, but failed validation when the job ran. |
| `timeout` | The job ran past its deadline, or the outbound call timed out. |
| `cancelled` | The job was cancelled. |
| `attempts_exhausted` | Every attempt allowed for the job type failed. |
| `outbound_forbidden` | The target is not allowed by the app's current fetch settings. |
| `outbound_quota_exceeded` | The app's fetch budget is spent. |
| `delegated_unattended` | The target needs a delegated user connection, which jobs cannot use. |
| `upstream_error` | The target answered with a non-success status, or could not be reached. |
| `result_invalid` | The response was not a complete JSON value. |
| `result_too_large` | The response was larger than 64 KiB. |
| `platform_error` | A platform failure. A `crashed` job carries this code. |

Messages are fixed text. They never contain your input, the upstream
response, or credentials.

### What the fetch job does

The fetch job makes one `GET` to the URL, under the app's fetch settings as
they are when the job runs, not when it was submitted. If an origin is
removed while a job waits, the job fails with `outbound_forbidden`.

- It does not follow redirects. A redirect is a non-success answer and fails
  with `upstream_error`.
- The `GET` times out after 30 seconds.
- The whole job, including time spent queued, must finish within five
  minutes of acceptance.
- It runs once. A failure is final, and the platform does not repeat the
  call. If the platform is interrupted after the target received the call,
  the job can end without the response, and the call is not undone.

Retry behavior is set by the platform for each job type. Your app cannot set
attempts, delays, deadlines, or retention.

## Retry keys

A network failure, a timeout, or a `503` does not tell you whether the job
was created. A retry key lets you resend the same submission safely.

Send the key in the `Idempotency-Key` header. Generate it once per intended
job, before the first send, and keep it with the exact body bytes:

- **Same key, same bytes:** you get the original job back with its current
  status. No second job is created, and finished work does not run again.
  This holds for simultaneous sends, lost replies, and service restarts.
- **Same key, different bytes:** `409 idempotency_conflict`. The comparison
  is byte for byte, so the same JSON with different spacing or key order is
  different input. Keep the exact string you sent, not an object you
  serialize again.
- **No key:** every `POST` creates a new job, even with identical input.

Use a fresh key only when the user deliberately starts new work. Generating
a new key for each HTTP retry defeats the protection.

A key is scoped to its server, app, environment, user, and job type. Two
users can use the same key without sharing a job or learning about each
other's jobs. A key is at most 128 UTF-8 bytes, and an empty or
whitespace-only key is refused with `400 idempotency_key_invalid`. A key is a
label, not a credential, but never put it in a URL.

A retry key prevents duplicate submission. It does not make execution
exactly once: a job type that allows several attempts can run its work more
than once inside one job.

## Errors from the jobs routes

Jobs errors are a flat JSON object with a `code` and a fixed `message`:

```json
{ "code": "rate_limited", "message": "Too many requests; back off and retry." }
```

The three conflict codes also carry the job's `status` and `error`:

```json
{
  "code": "job_terminal",
  "message": "The job has already finished.",
  "status": "succeeded",
  "error": null
}
```

| Status | Code | When | What to do |
| --- | --- | --- | --- |
| 400 | `job_server_unknown` | Submit names a server this deployment does not have. | Fix the configured type. Do not try another server. |
| 400 | `idempotency_key_invalid` | The `Idempotency-Key` header is empty, blank, or too long. | Fix the key. |
| 400 | `payload_invalid` | The input is not valid for the job type. No job was created. | Fix the input. Do not retry it unchanged. |
| 403 | `forbidden` | No grant for this type, the caller cannot use jobs, or a cross-origin request. | Stop retrying. Check the grant and the user. |
| 404 | `job_not_found` | No job with this reference is readable by this caller. | Stop. Do not submit a replacement automatically. |
| 409 | `idempotency_conflict` | The key was already used with different bytes. | Resend the original bytes, or start new work with a new key. |
| 409 | `job_not_ready` | Result read before the job finished. | Keep polling the status. |
| 409 | `job_terminal` | Result read of a job without a result, or cancel of a finished job. | Show the job's `status` and `error`. |
| 410 | `result_expired` | The result's seven days have passed. | Show that the result expired. |
| 413 | `payload_too_large` | The body is over 64 KiB. | Make the input smaller. |
| 429 | `rate_limited` | Too many submission attempts this minute. | Wait, then retry with the same key and bytes. |
| 429 | `jobs_capacity_exceeded` | No room for new work right now. | Wait, then retry with the same key and bytes. |
| 503 | `jobs_unavailable` | The jobs service could not be reached or could not answer in time. | Retry. A submission may have been accepted, so keep the key. |
| 503 | `jobs_disabled` | Jobs are not enabled here, or the job server is not accepting new jobs. | Retry later with the same key. |

`404 job_not_found` is the same answer for a job that never existed, a job
that belongs to another user, app, or environment, and a job whose record
has expired. The answer is identical so it never reveals that someone else's
job exists. App owners and administrators get no exception.

A `503 jobs_unavailable` on submit can also mean the platform has not yet
finished setting up jobs for an app that was just created or unarchived.
Retrying with the same key is the right response in every case.

### Errors that are not jobs errors

Before a request reaches the jobs routes, the app host checks the user's
session. Those checks answer the way they do for every `/_api/*` route, and
their bodies are not jobs errors. In particular, `401` with
`{"error": {"code": "refresh_required"}}` or `{"error": {"code":
"unauthorized"}}` means the session needs to be refreshed or renewed. An
archived app answers `410`, and an app the platform cannot find answers
`404`, often as a page rather than JSON.

Check the status code and the `content-type` before you parse a body, and
never treat a session error as a failed job.

## Limits

Your app cannot change these limits.

- **Submission rate.** 10 submission attempts per minute for each app and
  environment, shared by all of the app's users, plus a limit across the
  whole deployment. Every attempt counts, including keyed retries, refused
  input, and attempts that fail, and nothing is refunded. Status, result,
  and cancel requests do not count.
- **Capacity.** The jobs service limits how many unfinished jobs and how many
  stored jobs each app and environment can have. Finished jobs occupy stored
  capacity until their records are removed. The operator sets these limits.
  When there is no room, a submission gets `429 jobs_capacity_exceeded`.
  Nothing already accepted is evicted.
- **Execution.** Each app runs a small number of jobs at a time, so a job can
  wait in `queued` while others run. Order and queue time are not
  guaranteed.
- **Sizes.** Input and results are at most 64 KiB each. A progress label is
  at most 128 UTF-8 bytes.

The submission rate limit is why a retry loop needs backoff: a client that
retries in a tight loop uses up the app's allowance for every user.

## Cancellation

Only the user who started a job can cancel it. A cancellation of a queued
job stops it before it runs. A cancellation of a running job stops the
attempt. While the platform services are available, a cancelled job reaches
a terminal status within 60 seconds of the acknowledgement. While a running
job is being stopped, its progress can keep moving for up to about ten
seconds.

Cancellation races with completion, and the first outcome recorded wins:

- If the job finishes first, it keeps its result, and a later cancel answers
  `409 job_terminal` with the status `succeeded`.
- Once a job is `cancelled`, a late completion cannot change it.
- Cancelling never undoes an effect already sent to another system.

Repeating a cancel while the job is active is harmless. If a cancel reply is
lost, read the status or send the cancel again.

Some things do **not** cancel a job:

- Closing the tab, leaving the page, or abandoning a status request.
- The user's session expiring or being revoked.
- Removing the app's jobs grant. The grant controls new submissions and
  reads, so the user cannot see or cancel the job until the grant is back,
  but the job runs to the end.

**Archiving the app** cancels its queued and running jobs, in production and
in development. Unarchiving does not bring those jobs back; they stay
`cancelled`. New jobs can be submitted once the platform has caught up with
the unarchive, and until then submission answers `503 jobs_unavailable`.

## How long jobs are kept

| What | Readable for | Afterwards |
| --- | --- | --- |
| A successful result | 7 days from success | Status reads `expired`; the result read answers `410 result_expired` |
| The job record | 30 days from the job's terminal status | Every read answers `404 job_not_found` |

These times are when the job stops being readable, not when it is deleted.
Physical deletion happens later.

A retry key stays attached to its job until the job's record is physically
deleted. While it is attached:

- Resending the same key and bytes after the result expired returns the
  original job, now `expired`.
- Resending after the record expired returns `404 job_not_found` and creates
  nothing.
- Different bytes still answer `409 idempotency_conflict`.

After deletion, the old key can create a new job. Do not use
`recordExpiresAt` as a timer to resubmit an old key. If you need a result
for longer than seven days, save it, for example in the
[per-user store](/apps/gateway#storing-data).

## A complete client

This client covers the recovery cases above. It is for a page on the app's
own origin.

```js
const STORE = "helix-job";
const TERMINAL = ["succeeded", "failed", "crashed", "cancelled", "expired"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 1 s, 2 s, 4 s … capped at 30 s, with jitter.
const backoff = (n) => Math.min(30_000, 1_000 * 2 ** n) * (0.5 + Math.random() / 2);

function save(job) {
  localStorage.setItem(STORE, JSON.stringify(job));
}

function load() {
  const saved = localStorage.getItem(STORE);
  return saved === null ? null : JSON.parse(saved);
}

async function jsonBody(res) {
  const type = res.headers.get("content-type") ?? "";
  return type.includes("application/json") ? res.json() : null;
}

class SessionExpired extends Error {}

// One intended job: a key and the exact body bytes, saved before the first
// send so a reload can recover it.
function startFetchJob(url) {
  const job = {
    server: "jobs",
    type: "fetch",
    key: crypto.randomUUID(),
    body: JSON.stringify({ url }),
    jobId: null,
  };
  save(job);
  return job;
}

async function submit(job, maxAttempts = 6) {
  for (let n = 0; n < maxAttempts; n++) {
    let res;
    try {
      res = await fetch(`/_api/jobs/${job.server}/types/${job.type}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": job.key },
        body: job.body, // the saved string, never re-serialized
      });
    } catch {
      await sleep(backoff(n)); // no reply: the job may exist
      continue;
    }
    if (res.status === 202) {
      job.jobId = (await res.json()).jobId;
      save(job);
      return job;
    }
    if (res.status === 401) throw new SessionExpired();
    if (res.status === 429 || res.status === 503) {
      await sleep(backoff(n));
      continue;
    }
    const error = await jsonBody(res);
    throw new Error(`submission refused: ${res.status} ${error?.code ?? ""}`);
  }
  // Still uncertain. Keep the saved job and try again later with the same key.
  return null;
}

async function watch(job, onUpdate, signal) {
  let failures = 0;
  while (!signal.aborted) {
    let res = null;
    try {
      res = await fetch(`/_api/jobs/${job.server}/${job.jobId}`, { signal });
    } catch {
      if (signal.aborted) return null;
      // A network failure is a failed read, not a failed job.
    }
    if (res?.status === 200) {
      failures = 0;
      const snapshot = await res.json();
      onUpdate({ snapshot, stale: false });
      if (TERMINAL.includes(snapshot.status)) return snapshot;
      await sleep(2_000);
      continue;
    }
    if (res?.status === 401) throw new SessionExpired();
    if (res && res.status !== 503) {
      // 403 or 404: this user cannot read the job. Stop polling.
      const error = await jsonBody(res);
      throw new Error(`status read refused: ${res.status} ${error?.code ?? ""}`);
    }
    onUpdate({ snapshot: null, stale: true }); // keep showing the last state, marked stale
    await sleep(backoff(failures++));
  }
  return null;
}

async function readResult(job) {
  const res = await fetch(`/_api/jobs/${job.server}/${job.jobId}/result`);
  if (res.status === 200) return { value: await res.json() }; // may be null
  if (res.status === 401) throw new SessionExpired();
  const error = await jsonBody(res);
  return { error: error?.code ?? `http_${res.status}`, status: error?.status ?? null };
}

async function cancel(job) {
  const res = await fetch(`/_api/jobs/${job.server}/${job.jobId}`, { method: "DELETE" });
  if (res.status === 401) throw new SessionExpired();
  return res.status; // 202: keep watching. 409: already finished.
}

// On page load: resume the saved job instead of starting a new one.
async function resume(onUpdate, signal) {
  const job = load();
  if (job === null) return null;
  try {
    if (job.jobId === null && (await submit(job)) === null) return null;
    return await watch(job, onUpdate, signal);
  } catch (error) {
    if (error instanceof SessionExpired) {
      // A navigation renews the session. The saved job survives the reload,
      // and resume() picks it up again.
      location.reload();
    }
    throw error;
  }
}
```

The points that matter:

- The job is saved before the first send. A reload in the middle of a
  submission resends the same key and bytes, which returns the original job
  rather than a duplicate.
- A failed status read keeps the last snapshot on screen, marked stale. The
  job keeps running.
- An expired session stops polling and reloads the page. Reloading renews
  the session; the saved reference is reused. Recovering a session never
  submits new work.
- Polling stops at a terminal status, on `403` or `404`, or when the view
  closes (`signal`). Stopping polling never cancels the job.
- Clear the saved job when you have saved its result or the user dismisses
  it.

## Developing with the dev gateway

The [dev gateway](/apps/quickstart#_5-developing-before-you-deploy), when
your deployment runs one, supports the same four operations, with the app
slug in the path and a dev token:

```text
POST   https://dev-api.<base>/<slug>/_api/jobs/:server/types/:type
GET    https://dev-api.<base>/<slug>/_api/jobs/:server/:jobId
GET    https://dev-api.<base>/<slug>/_api/jobs/:server/:jobId/result
DELETE https://dev-api.<base>/<slug>/_api/jobs/:server/:jobId
Authorization: Bearer azxdev_…
```

Requests must come from an origin registered with the token. The gateway
allows the `Idempotency-Key` header from a registered origin and refuses
other origins.

Dev jobs are separate from production jobs. They run in the `dev`
environment and belong to the developer who minted the token. A production
session cannot see them, a dev token cannot see production jobs, and the
same retry key in each environment creates two separate jobs. Both
environments use the same grant from the app's manifest, so a missing grant
shows up in development too. A dev job's outbound call injects only
dev-tier connection secrets, never production ones.

To adapt the client above, prefix each path with the dev gateway base and
add the `Authorization` header. The session handling does not apply: an
expired or revoked token answers `401`, and you need a new token.

## When the operator retires a job server

An operator can stop a job server from taking new work while keeping its
existing jobs. While a server is retiring:

- New submissions answer `503 jobs_disabled`.
- Status, result, and cancel requests for existing jobs keep working.
- Resending a saved key and bytes still returns the original job.
- Your saved grant stays, marked "not offered on this deployment".

Always send reads and cancels to the job's original `server`. The platform
never redirects a reference to another server, and a server name it does not
know answers `404 job_not_found`.

## What jobs do not promise

- **Exactly-once execution.** A retry key stops duplicate jobs, not repeated
  work inside a job type that retries.
- **Undoing effects.** Neither cancellation nor failure reverses a call that
  already reached another system.
- **Every progress update.** Polling shows the latest state, not each step.
- **A fixed delivery time.** There is no freshness guarantee, and a queued
  job can wait.
- **Test job types in production.** The production catalogue contains only
  the fetch job.
