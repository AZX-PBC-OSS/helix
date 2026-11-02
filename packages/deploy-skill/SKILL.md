---
name: helix-app
description: Build and deploy a web app on the Helix app platform. Use when writing, changing, or deploying an app hosted on Helix — static frontends that reach models, data, and third-party APIs only through the platform's /_api/* gateway, under a capability manifest and a strict Content-Security-Policy, deployed with the helix CLI.
---

# Building an app on Helix

Helix hosts AI-built web apps behind single sign-on. It treats **every app as
untrusted code** and contains it rather than reviewing it. Every rule below follows
from that, and several of them can't be retrofitted, so read this before writing code.

This file is deliberately short. It holds the rules you must not break, this
deployment's addresses, and where to look up everything else.

## This deployment

- **Portal** (API and UI): `{{PORTAL_ORIGIN}}`
- **Your app**, once deployed: `https://<slug>.{{APPS_HOST}}`
<!-- IF:DEV_API -->
- **Dev gateway**, for calling the platform before you deploy: `{{DEV_API_BASE}}/<slug>`.
  How to use it: https://azx-pbc-oss.github.io/helix/apps/dev-gateway.md
<!-- /IF:DEV_API -->

## Where to look things up

- **What this deployment offers right now**: the models you can use, the budgets
  that apply without approval, the stored connections and OAuth providers you can
  bind, the visibility modes allowed, the deploy size limits, the background job
  types you can grant, and whether the dev gateway is on. Run:

  ```bash
  npx -y @azx-pbc/helix-cli@latest capabilities
  ```

  Run it before writing the manifest. Never guess these values.

- **How the platform works**: the public docs. Each page has a markdown version,
  which is the cheapest form to fetch:
  - Start here: https://azx-pbc-oss.github.io/helix/apps/quickstart.md
  - Manifest and approvals: https://azx-pbc-oss.github.io/helix/apps/manifest.md
  - The `/_api` gateway (LLM, app data, fetch proxy, identity): https://azx-pbc-oss.github.io/helix/apps/gateway.md
  - CSP, serving rules, offline: https://azx-pbc-oss.github.io/helix/apps/serving-and-csp.md
  - Connected accounts (OAuth providers): https://azx-pbc-oss.github.io/helix/apps/connected-accounts.md
  - Background jobs (work that outlives the page): https://azx-pbc-oss.github.io/helix/apps/jobs.md
  - Error codes: https://azx-pbc-oss.github.io/helix/apps/errors.md
  - The CLI: https://azx-pbc-oss.github.io/helix/apps/cli.md
  - Everything in one file: https://azx-pbc-oss.github.io/helix/llms-full.txt

  Fetch the page for a feature before you use it. The docs describe the latest
  release. If this deployment refuses something the docs describe, it may be
  running an older version: `capabilities` and the portal's error message are the
  authority for this deployment.

## Rules you must not break

- **Static frontend only.** You ship HTML, CSS, JS, and assets. There is no server
  code, no environment variables, and no build step on the platform. Never put an
  API key or other secret in the bundle.
- **No direct third-party `fetch()`.** The CSP sets `connect-src 'self'`. Call
  other APIs through the platform: `fetch('/_api/fetch/https://api.example.com/…')`.
  The platform can inject a stored credential so no key reaches the browser. A
  direct browser call needs an approved `externalOrigins` grant.
- **Everything dynamic goes through `/_api/*`** on your app's own origin: the LLM
  (`POST /_api/llm/chat`, provider-neutral, so don't add a vendor SDK), app data
  (`/_api/data/*`), and the fetch proxy. Each one needs a grant in the manifest.
  An undeclared capability answers `403`. That is expected, not a bug.
- **Some grants wait for a human.** Outbound origins, OAuth providers, shared-data
  prefixes, `public` visibility, and budgets above the baseline queue for admin
  approval. Design for the wait, and never work around it by hardcoding a key.
- **Identity is free.** Unless the app is `public`, only signed-in users reach it,
  so don't build a login screen. `GET /_api/me` returns
  `{user: {id, displayName, email}}`. Use `id` as the key for anything you store
  about a person. `email` can be `null`.
- **Shared data writes are compare-and-swap.** `PUT /_api/data/shared/:key` must
  send `If-Match: "<etag>"` from your last read, or `If-None-Match: *` to create
  the key. On `412`, re-read and retry a bounded number of times. Never keep your
  own "index" key over a growing set of records; use the prefix list call.
  Per-user state goes in `/_api/data/user/*`, never in `shared`.
- **A job submit keeps its key.** Work that must outlive the page is a
  background job (`/_api/jobs/*`), granted by the exact type `capabilities`
  lists. Save the `Idempotency-Key` and the exact body string **before** the
  first send. On no reply, `429` or `503`, resend the same key and bytes with
  backoff; a new key is new work. On `401`, never resubmit: let the user sign in
  again, then resume the saved job. Stopping polling never cancels a job.
- **No service workers of your own.** Registering one is refused. If the app must
  work offline, request the `offline` capability and the platform supplies the
  worker.
- **Reserved paths.** Don't route on `/_api/*`, `/_auth/*`, or `/_helix/*`.
- **Web app manifest:** use
  `<link rel="manifest" href="…" crossorigin="use-credentials">`. Without the
  attribute the browser fetches the manifest without the session cookie, gets
  `401`, and the app silently can't be installed.
- **Show errors as they are.** Show `403` and `429` from the gateway to the user.
  For a `403 connection_required`, offer a visible Connect button; nothing retries
  automatically.

## Build and deploy

Build to a directory (`dist/` by convention). The directory's **contents** become
the site root, so it needs an `index.html` at the top. Vite and plain HTML both work.

Put a `helix.json` next to your project. `portalUrl` is what points the CLI at
this deployment. Without it, every command tries a local development portal.

```json
{
  "slug": "my-app",
  "dir": "dist",
  "portalUrl": "{{PORTAL_ORIGIN}}",
  "description": "Tracks Q3 cloud spend by team."
}
```

Write the description yourself: one plain-text sentence (500 characters at most)
saying what the app does and who it is for. It appears under the app's name in
the portal.

Run the CLI with `npx`, so it is always the current version. It needs Node 22.12
or later.

```bash
npx -y @azx-pbc/helix-cli@latest login          # browser sign-in
npx -y @azx-pbc/helix-cli@latest capabilities   # what you may request here
npx -y @azx-pbc/helix-cli@latest create --display-name "My App" --description "Tracks Q3 cloud spend by team."
# set the app's capabilities in the portal (Capabilities tab) before relying on them
npx -y @azx-pbc/helix-cli@latest deploy         # uploads dist/ as a new preview version
npx -y @azx-pbc/helix-cli@latest versions       # preview vs live
npx -y @azx-pbc/helix-cli@latest promote <n>    # make version <n> live
```

Every deploy lands as a **preview**. Promoting it is a separate step;
`deploy --promote` does both. Read the CSP warnings the upload prints. Each one
is a request that will be blocked in production.

To deploy on every push from GitHub, run
`npx -y @azx-pbc/helix-cli@latest ci init` from the app's directory and commit
the files it writes. The workflow it generates pins a CLI version, which is
correct for CI. Never add a Helix token to the repository's secrets.

## Before you call it done

- [ ] No server code, no `.env`, no key anywhere in the bundle.
- [ ] Every third-party call goes through `/_api/fetch/<url>` or has an approved
      `externalOrigins` grant.
- [ ] Every capability the code uses is declared in the manifest, within what
      `capabilities` reports.
- [ ] Gateway errors (`403`, `429`, `connection_required`) are shown to the user.
- [ ] Shared writes use `If-Match` / `If-None-Match: *` and retry a bounded number of times on `412`.
- [ ] Nothing user-specific or sensitive is in a `shared` key or the console.
- [ ] Job submits save the key and body before sending, reuse both on every retry,
      and never resubmit on `401`.
- [ ] The build has a root `index.html` and deploys without CSP warnings.

The full checklist, with links: https://azx-pbc-oss.github.io/helix/apps/quickstart.md#before-you-call-it-done
