---
title: App manifest
description: "The per-app declaration of what an app may do: models, app-data scopes and prefixes, fetch origins with connections or OAuth providers, injected helpers, offline, visibility, and budgets — what applies immediately, what queues for approval, and how the gateway enforces it."
---

# The app manifest

Every app has a manifest that declares what it is allowed to do. The portal
stores it, and the gateway checks it on every call, so nothing an app does at
runtime can go beyond its manifest.

The manifest exists **before any code is deployed**. You edit it on the
portal's Capabilities tab, or with `GET`/`PUT /api/v1/apps/<slug>/manifest` on
the portal API.

A capability you didn't declare answers `403`. That is the expected failure,
not a bug.

## What an app can ask for

```jsonc
{
  "app": "my-app", // the slug
  // internal | password | public, or { "mode": "group", "groupIds": ["<id>", ...] }
  // for "members of any of these directory groups" (at most 10). Set group
  // visibility from the portal's Access tab, which has a picker.
  "visibility": { "mode": "internal" },
  "capabilities": {
    "llm": {
      "models": ["claude-haiku-4-5"], // exact ids; anything else is 403 model_not_allowed
      "dollarsPerDay": 5 // daily spend cap in USD; omit for no cap
    },
    "data": {
      "user": true, // a private store for each signed-in user
      "collections": ["signups"], // append-only; the app can't read them back
      "sharedRead": ["config"], // app-wide keys every user can read
      "sharedWrite": [], // writing a key does not grant reading it
      "sharedReadPrefixes": ["record:"], // every key starting with this prefix
      "sharedWritePrefixes": ["record:"], // same, for writes; REQUIRES writesPerDay
      "writesPerDay": 10000,
      "bytesPerDay": 50000000
    },
    "mcp": [], // accepted but not enforced yet: no MCP transport exists
    "externalOrigins": [], // origins the browser may call directly (adds them to the CSP)
    "fetch": {
      "origins": [
        { "origin": "https://api.github.com" }, // proxied, no credential
        { "origin": "https://api.stripe.com", "connection": "stripe-test" }, // stored secret, added server-side
        { "origin": "https://app.acme.example", "provider": "acme", "required": true } // the user's own OAuth connection
      ],
      "requestsPerDay": 10000
    },
    "shim": { "fetch": false, "connect": false }, // helper scripts the platform adds to your HTML
    "offline": { "scope": "/app/" }, // a service worker supplied by the platform
    "jobs": { "types": ["jobs:fetch"] } // background job types; jobs:fetch calls go through fetch.origins
  }
}
```

Every capability is an explicit grant; nothing is implied. An app with no `llm`
block can't call the model gateway, and an app with no `fetch` block can't
proxy an outbound call, and an app with no `jobs` block can't start a
[background job](./jobs).

What each capability does at runtime:

- `llm`, `data`, and `fetch`: [the `/_api` gateway](./gateway).
- `externalOrigins` and `offline`: [Serving rules and CSP](./serving-and-csp).
- `shim.fetch`: [the fetch shim](./gateway#the-fetch-shim).
- `shim.connect` and `provider` origins: [Connected accounts](./connected-accounts).
- `jobs`: [Background jobs](./jobs).

### Values that depend on your deployment

These are set by your deployment's operator, and `helix capabilities` lists
them:

- the model ids allowed in `llm.models`;
- the named `connection` secrets you can reference;
- the OAuth `provider` refs you can bind, and the API origins each one covers;
- the job types you can list in `jobs.types`;
- which visibility modes are allowed.

Use those names exactly. Don't guess them.

### Connections and providers

A fetch origin can carry one source of credentials, never both:

- **`connection`** names a secret the platform stores. The proxy adds it to every
  call to that origin, whoever is signed in. You never see its value, and
  credentials never go in app code or in the manifest.
- **`provider`** names an OAuth connection provider. The proxy adds **the
  signed-in user's own** token, so each user brings their own access. See
  [Connected accounts](./connected-accounts).

## Visibility

An app is one of:

| Mode | Who can open it |
| --- | --- |
| `internal` | Signed-in users of the deployment (the default) |
| `group` | Members of specific directory groups |
| `password` | Anyone with the shared passphrase (only if the deployment allows it) |
| `public` | Anyone, no sign-in (only if the deployment allows it) |

## Approvals

Changes inside your deployment's **baselines** apply immediately. The baselines
are the curated models and daily caps on LLM spend, data writes, data bytes,
and proxied requests; `helix capabilities` shows the numbers.

These changes are filed as an approval request for a platform admin instead:

- any `externalOrigins` entry;
- any `fetch.origins` entry;
- any `mcp` server;
- any `sharedReadPrefixes` or `sharedWritePrefixes` entry, since one prefix
  covers any number of keys;
- going `public`;
- a model outside the curated set;
- any budget above its baseline.

Plan for the wait. Don't design around it by, for example, hardcoding a key in
the bundle. The portal tells you which kind of change you are submitting before
you submit it.

Two more rules:

- **Reducing privilege never needs approval.** Removing a grant, lowering a
  budget, or going from public back to internal all apply immediately.
- **Adding a budget is a reduction, and removing one is an increase.** An unset
  budget means unlimited, so removing a cap gives the app more power and needs
  approval.

If a submission contains anything that needs approval, the whole submission
becomes one pending request, and the admin sees the full diff.

A write prefix also requires a `writesPerDay` budget. The manifest refuses
`sharedWritePrefixes` without one (a `400` naming the field), because each write
under a prefix can create a new key.

## Where this is enforced

The gateway checks the manifest on every request:

- each LLM call against the model list and the budget;
- each data call against the key, prefix, and collection grants;
- each proxied call against the origin list;
- each page load against the CSP built from the manifest.

Data keys (collection names, shared keys, and prefixes) must be printable
ASCII, so what the admin sees in the approval diff is exactly what was stored.

The schema is in [`packages/shared/src/manifest.ts`](https://github.com/AZX-PBC-OSS/helix/blob/main/packages/shared/src/manifest.ts).
