---
title: The /_api gateway
description: "The same-origin /_api/* endpoints an app calls for everything dynamic: LLM proxying, app data in three scopes, and the fetch proxy — gated by the manifest, metered and budgeted."
---

# The `/_api` gateway

Apps are static frontends with no server code, so everything dynamic goes
through the gateway the platform serves on your app's own origin, at `/_api/*`.
Your app never holds an API key. Each part of the gateway is gated by the
[app manifest](/apps/manifest), metered, and budgeted.

## Calling a language model

`POST /_api/llm/chat` proxies to the platform's LLM vendor. The request names a
model from your manifest's `llm.models` list; the response streams back as
server-sent events. The platform meters tokens against the app's daily USD
budget, and the call is rejected once the budget is spent.

Model names are the platform's catalog ids and never change with where the
platform runs inference — first-party vendors or an Azure AI Foundry account in
the operator's own subscription (an operator concern; see
[Azure AI Foundry](/deploy/foundry)). An app moves between such installs
untouched.

## Storing data

`/_api/data/*` is three stores in one:

- **Per-user store** (`user: true` in the manifest): a JSON document per
  signed-in user. Each user sees only their own.
- **Collections**: append-only queues. An app can write entries and never read
  them back — the owner drains them through the portal. This is how a public
  contact form or vote works without exposing anyone's data.
- **Shared keys**: values any visitor can read or write, with grants by exact
  key or by key prefix. Writes are versioned: send `If-Match` with the version
  you read, and the write fails with `412` if someone else won the race. Retry
  by re-reading. That compare-and-swap loop is the tool for anything
  concurrent, like a counter or a stock quantity.

## Calling external APIs

Two ways to reach a third-party host, depending on the manifest:

- **`externalOrigins`** adds a host to the page's Content-Security-Policy, and
  the browser calls it directly. Only for hosts that accept anonymous traffic.
- **`fetch.origins`** routes the call through the platform's egress proxy:
  `fetch('/_api/fetch/https://api.example.com/thing')`. The proxy injects the
  connection's API key server-side if the origin has one attached, so the key
  never reaches the browser.

With `fetch.shim: true` the platform rewrites the page's `fetch` and `XMLHttpRequest`
at serve time, so ordinary third-party client libraries work without code
changes and calls flow through the proxy automatically.

## Offline

`offline.scope` makes the platform serve a service worker that caches your
app's assets, so it cold-boots with no network. The worker is platform-authored
and confined to your app's scope; the app ships no worker code.

## What to build with

The [quickstart](/apps/quickstart) walks through all of this with real request
and response bodies, and the
[example apps](https://github.com/AZX-PBC-OSS/helix/tree/main/examples) are
small, deployable references for each capability:

| Example | Shows |
| --- | --- |
| `hello-world` | The smallest deployable bundle |
| `chatbot` | Streaming an LLM through the gateway |
| `waitlist` | A public app with a write-only collection |
| `oversell` | The compare-and-swap write pattern |
| `fetch-proxy` | Calling the GitHub API with an injected key |
| `offline` | The offline service worker |
