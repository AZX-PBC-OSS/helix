# background-fetch

An internal Helix app that shows **background jobs** (ADR-0045) doing visible
work: start a batch of `jobs:fetch` jobs, close the tab, and come back (here
or on another device) to finished results.

The page never calls an outside origin itself. Each job is one `GET` that the
platform makes on the user's behalf, through the app's fetch grants and
egress, after the request that started it has ended. The page only remembers
which jobs it started and polls them.

## What it shows

Three tabs, each starting one **run** (a batch of jobs):

- **Weather snapshot.** Eight cities, one Open-Meteo forecast job each. The
  results fill a table.
- **Slow batch.** Eight jobs that each wait ten seconds (`httpbin.org/delay/10`).
  At most two jobs run at a time per app, so the batch takes about 40 seconds:
  long enough to close the tab and come back. On return, the page reports how
  many jobs finished while it was closed.
- **Failure lab.** Seven jobs built to end a particular way, each shown
  against the outcome the platform promises:

  | Case                                                 | Expected                                                   |
  | ---------------------------------------------------- | ---------------------------------------------------------- |
  | `httpbin.org/json` (control)                         | `succeeded`                                                |
  | `httpbin.org/delay/10`, cancelled right after submit | `cancelled` (or `succeeded` if it finishes first)          |
  | `httpbin.org/status/500`                             | `failed` · `upstream_error`                                |
  | `httpbin.org/redirect-to?…`                          | `failed` · `upstream_error` (redirects are not followed)   |
  | `httpbin.org/html`                                   | `failed` · `result_invalid`                                |
  | `jsonplaceholder.typicode.com/photos` (~1 MB)        | `failed` · `result_too_large`                              |
  | `example.com` (not granted)                          | `failed` · `outbound_forbidden`, decided when the job runs |

  Two probes answer immediately: **Reuse a retry key** (same key and bytes
  return the same job; same key with different bytes is
  `409 idempotency_conflict`) and **Hit the submission window** (malformed
  submissions until `429 rate_limited`, which creates no jobs).

## How a run survives the tab

A run's record lives in the user's private store at `run:<id>`
(`/_api/data/user/*`), and it is written **before** anything is submitted. It
holds each job's `Idempotency-Key` and its exact body text. Then:

1. Each job is submitted with its key, and the returned `jobId` is saved.
2. If the tab closes partway through submitting, the next load finds jobs
   with no `jobId` and resubmits them with the same keys. The platform
   returns the original job for a known key, so nothing runs twice.
3. A `429` or `503` on submit holds further submissions for 15 seconds and
   retries with the same key. Three batches together are more than the
   default ten submissions per minute, so this path is normal, not an error.
4. Only unfinished jobs are polled, every 2 seconds while something changes
   and backing off to 10 seconds when nothing does.
5. A successful result is read once and copied into the run record if it is
   under 8,000 characters, so the history outlives the seven-day result
   retention.

`GET /_api/data/user` lists the runs, which is why the history works across
devices: there is no "list my jobs" route.

## Grants

```bash
curl -fsS -X PUT "http://localhost:3001/api/v1/apps/background-fetch/manifest" \
  -H "authorization: Bearer $HELIX_TOKEN" \
  -H "content-type: application/json" \
  -d '{"capabilities":{
        "data":{"user":true},
        "fetch":{"origins":[
          {"origin":"https://api.open-meteo.com"},
          {"origin":"https://httpbin.org"},
          {"origin":"https://jsonplaceholder.typicode.com"}
        ],"requestsPerDay":500},
        "jobs":{"types":["jobs:fetch"]}
      }}'
```

`data.user` and `jobs.types` apply immediately. The three fetch origins open
one approval request: approve it in the portal's Approvals screen (or
`POST /api/v1/approvals/<id>/approve`). Until it is approved, every job fails
with `outbound_forbidden`, which is what the lab's `example.com` case shows on
purpose.

No `externalOrigins` entry is needed, because the browser never calls these
origins. `helix deploy` warns that the bundle references `https://example.com`
and that the CSP will block it. That warning is expected: the string is a job
input, not a browser request.

## Build and deploy

```bash
cd examples/background-fetch
pnpm install --ignore-workspace
pnpm build                        # regenerate dist/ (committed to git)

export HELIX_TOKEN="$PORTAL_DEV_TOKEN"
helix create --display-name "Background fetch" --visibility internal
# set the grants and approve the origins (see above)
helix deploy --promote
```

Jobs must be running (`pnpm dev:jobs`, see `apps/jobs/README.md`), and egress
needs outbound internet. Open
`https://background-fetch.local.helix.azxlabs.io:8080` and sign in.

## Verifying a deployed install

On an Azure install with `deployJobs` enabled, this app is a quick end-to-end
check of the jobs plane:

1. Deploy it as above against the install's portal, and approve the origins.
2. Start the **slow batch**, close the tab, and reopen the app after a
   minute. Expect "8 jobs finished while this page was closed".
3. Reopen it on a second device signed in as the same user. The run is there.
4. Run the **failure lab**. Every row should end with "✓ as expected".
5. Check the jobs alerts and the App Insights traces for the run's spans.
