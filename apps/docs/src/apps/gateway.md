---
title: The /_api gateway
description: "The same-origin /_api/* endpoints an app calls for everything dynamic: identity, LLM proxying with streaming and structured output, app data in three scopes with compare-and-swap writes, the fetch proxy, and background jobs — gated by the manifest, metered and budgeted."
---

# The `/_api` gateway

Apps are static frontends with no server code, so everything dynamic goes
through the gateway the platform serves on your app's own origin, at `/_api/*`.
It is same-origin and uses the session cookie, so there is no CORS and no key.
Call it with a plain `fetch`.

Each part of the gateway is gated by the [app manifest](./manifest), metered,
and budgeted. A capability the manifest doesn't grant answers `403`; that is the
expected failure, not a bug.

Calls that change data are Origin-checked, so they must come from the app's own
page. A `curl` from a terminal is refused. To call the gateway from a local dev
server, use the [dev gateway](./dev-gateway).

## Identity

Unless the app is `public`, the platform only serves signed-in users, so you
don't build a login screen. `GET /_api/me` returns the current user:

```json
{ "user": { "id": "…", "displayName": "Ada Lovelace", "email": "ada@example.com" } }
```

- **Use `id` as the key** for anything you store about a person. It is the
  user's directory object id: stable for the life of the user, and the value the
  data scopes already partition on.
- **`displayName` and `email` are for display only.** `email` is `null` when
  there is no address to show. A shared-password app, for example, signs
  everyone in as `Guest`. Handle that case instead of printing "null", and never
  use `email` as an identity or as somewhere to send messages.

`/_api/me` is never served from a cache, so an offline app can also use it to
check whether the network is back. See [Offline](./serving-and-csp#offline).

## Calling a language model

`POST /_api/llm/chat` sends a chat to the platform's model provider. The API is
provider-neutral, so don't add a vendor SDK.

```js
const res = await fetch("/_api/llm/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "claude-haiku-4-5", // must be in the manifest's llm.models
    system: "You are terse.", // top-level, NOT a message with role "system"
    messages: [{ role: "user", content: "hello" }], // roles: user | assistant
    maxTokens: 1024, // default 1024
    stream: true, // default true
  }),
});
```

`helix capabilities` lists the models your deployment serves. Choose the
cheapest one that does the job. A small, fast model is usually right for
classification, extraction, and short text. The operator chooses whether calls
go to first-party vendors or Azure AI Foundry; the model ids and the request
format are the same either way.

Every call is priced and counted against the app's daily USD budget
(`llm.dollarsPerDay`). Once the budget is spent, new calls are refused and calls
already running finish.

### Streaming

With `stream: true` (the default), the response is server-sent events:

```
event: delta   data: {"text":"..."}                       zero or more
event: done    data: {"stopReason":"...","usage":{...}}   terminal, success
event: error   data: {"code":"...","message":"..."}       terminal, failure
```

`EventSource` can't send a POST, so read the stream from the `fetch` response
body. With `stream: false` you get a single JSON body:
`{ model, content, stopReason, usage }`.

### Structured output

Add `responseFormat` to get JSON that matches a schema:

```js
body: JSON.stringify({
  model: "claude-haiku-4-5",
  messages: [{ role: "user", content: "Rome, 3 days" }],
  maxTokens: 4096, // leave room for the JSON
  stream: false,
  responseFormat: {
    type: "json_schema", // the only mode
    name: "itinerary", // optional, [A-Za-z0-9_-]{1,64}
    schema: {
      type: "object", // the root must be an object
      properties: { days: { type: "array", items: { type: "string" } } },
      required: ["days"],
      additionalProperties: false, // required
    },
  },
});
```

The JSON comes back as ordinary `content`, or as `delta` frames when streaming.
Call `JSON.parse` on it yourself.

The schema is always **enforced**; there is no best-effort mode. It must stay
within the strict subset:

- every property is listed in `required`;
- `additionalProperties: false`;
- no recursion;
- no `minLength`, `minimum`, or similar constraints;
- under 32 KB and 12 levels deep.

If the response is `400 validation_failed` and mentions
`responseFormat.schema`, the provider rejected the schema. Fix it; retrying the
same schema won't help.

**Set `maxTokens` generously, and check `stopReason` before parsing.** Prose
that hits the token limit is merely cut short. JSON that hits it can't be
parsed, so `JSON.parse` throws. Check that `stopReason` is not `"max_tokens"`,
in the response body or the `done` frame, before parsing.

Not every model can enforce a schema. Asking one that can't returns `400`;
those models still work for plain text.

- **Can enforce a schema:** `claude-haiku-4-5`, `claude-opus-4-8`,
  `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, `claude-fable-5-1`.
- **Cannot:** `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`.

## Storing data

`/_api/data/*` is three stores with different access rules, not one general
key-value store:

```
PUT    /_api/data/user/:key          store a value for the signed-in user
GET    /_api/data/user/:key          read it back
DELETE /_api/data/user/:key
GET    /_api/data/user               list this user's keys
POST   /_api/data/collections/:name  append one item  → 201, empty body
GET    /_api/data/shared/:key        app-wide, readable by every user
PUT    /_api/data/shared/:key        compare-and-swap — see below
GET    /_api/data/shared?prefix=p    list keys under a granted prefix
```

- **`user`** (`data.user: true`) is a private store per signed-in user, kept
  separate by the database itself. A `public` app has no user store and gets
  `403`.
- **`collections`** are **append-only and can't be read from the app**. There
  is no list, get, or delete call. They suit a signup form, a feedback box, or
  a survey. The owner reads the collection in the portal. Anonymous visitors to
  a `public` app can append.
- **`shared`** keys are visible to everyone who can open the app. Never put
  anything user-specific or sensitive in them.

Values are any JSON up to **64 KiB**. Keys, prefixes, and collection names are
identifiers, not prose: printable ASCII (`0x20`–`0x7E`), 1–256 characters, with
no leading or trailing space. Put human-readable text in the value.

```js
await fetch("/_api/data/user/prefs", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ theme: "dark" }),
});
const prefs = await (await fetch("/_api/data/user/prefs")).json();
```

### Shared writes are compare-and-swap

Every read of a `user` or `shared` key returns an `ETag: "<version>"` header.
The version is an opaque token, not a timestamp, so never parse it.

A `PUT /_api/data/shared/:key` **must** carry one of two headers:

- `If-Match: "<version>"`: write only if the value hasn't changed since you
  read it;
- `If-None-Match: *`: create the key only if it doesn't exist yet.

The responses that matter:

- **No header:** refused with `428 precondition_required`.
- **Stale version:** `412 conflict`. Someone else wrote between your read and
  your write. Re-read, apply your change again, and retry.

Neither response counts against `writesPerDay`, but always cap the number of
retries. `If-Match: *` is refused, because it guarantees nothing.

Writes to the `user` store may leave the header out, because the only race there
is one person in two tabs, and the last write winning is fine. If you do send
it, it is honored.

```js
// Read, modify, write with If-Match, and retry on 412.
async function updateShared(key, mutate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`/_api/data/shared/${key}`);
    // A failed read is not "key absent": treat only 404 as missing.
    if (!res.ok && res.status !== 404) throw new Error(`read failed: ${res.status}`);
    const current = res.status === 404 ? undefined : (await res.json()).value;
    const etag = res.headers.get("etag"); // null when the key doesn't exist yet
    const put = await fetch(`/_api/data/shared/${key}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(etag ? { "if-match": etag } : { "if-none-match": "*" }),
      },
      body: JSON.stringify(mutate(current)),
    });
    if (put.ok) return;
    if (put.status !== 412) throw new Error(`shared write failed: ${put.status}`);
    // 412: another write won; the next loop re-reads its value.
  }
  throw new Error(`"${key}" is contended — gave up after 3 attempts`);
}
```

The [`oversell` example](https://github.com/AZX-PBC-OSS/helix/tree/main/examples/oversell)
uses this loop to keep a stock count correct under concurrent buyers.

If a key is in `sharedWrite` but not `sharedRead`, the app can't read it
(`GET` answers `403`), so the loop above can't work. The `412` response still
includes the current version: retry once with
`if-match: "<error.details.currentVersion>"`. That overwrites a value you never
saw, so prefer granting `sharedRead` on any key the app writes.

### Prefix grants and listing

The literal `sharedRead` and `sharedWrite` lists are fixed in the manifest. An
app whose records are created by users, such as one key per submission
(`record:<id>`), can't list those ids in advance. Prefix grants solve that:

- **`sharedReadPrefixes` / `sharedWritePrefixes`** cover every key that starts
  with the prefix. The match is an exact "starts with"; there are no wildcards.
- They also allow **listing**. A list returns keys and versions but never
  values, 200 keys per page.

```js
// Create a record under a new random key. If-None-Match: * guarantees that
// if two writers somehow chose the same id, only one succeeds.
const id = crypto.randomUUID();
await fetch(`/_api/data/shared/record:${id}`, {
  method: "PUT",
  headers: { "content-type": "application/json", "if-none-match": "*" },
  body: JSON.stringify(record),
});

// List the records with one call. Don't keep your own "index" key: it is
// capped at 64 KiB, and concurrent creations would overwrite each other.
const page = await (await fetch("/_api/data/shared?prefix=record:")).json();
// page = { keys: [{ key, version, updatedAt }, ...], nextCursor? }
// Pass nextCursor back as ?cursor=… until it is absent. A listed version is a
// valid If-Match value, so you can update a key without reading it first.
```

Listing rules:

- The prefix you list must be covered by a `sharedReadPrefixes` grant, either
  equal to it or narrower.
- A literal `sharedRead` grant does not allow listing.
- There is no way to list without a prefix.
- A `403` on a list means the prefix isn't granted. That is the limit on what
  the app can enumerate, and the attempt is audited.

A write prefix requires a `writesPerDay` budget. Each call can create a new key,
and shared keys can't be deleted yet, so the manifest refuses
`sharedWritePrefixes` without that budget. Read prefixes need no budget.

## Calling external APIs

The page's [CSP](./serving-and-csp) sets `connect-src 'self'`, so the app can't
`fetch()` a third-party origin directly. There are two ways around that, and
both need a manifest grant:

- **The fetch proxy (`fetch.origins`)** is the recommended route. Put the
  absolute target URL after `/_api/fetch/`:

  ```js
  const r = await fetch("/_api/fetch/https://api.github.com/repos/vercel/next.js");
  ```

  The method, headers, and body pass through. The platform:
  - injects the origin's stored `connection` credential, or the signed-in
    user's own token for a provider-bound origin (see
    [Connected accounts](./connected-accounts));
  - blocks private, loopback, and cloud-metadata addresses;
  - refuses redirects;
  - streams the response back with `Cache-Control: no-store`, dropping the
    upstream's own cache headers (`Cache-Control`, `Expires`, and the
    CDN-targeted ones).

  The app's own `cookie` and `authorization` headers are never forwarded. Calls
  are audited and counted against `fetch.requestsPerDay`.

- **`externalOrigins`** adds an origin to the page's CSP so the browser calls it
  directly. Use it only for public, keyless APIs that allow cross-origin
  requests. WebSocket, `EventSource`, and `<img>`, `<form>`, and font loads
  can't go through the proxy, so they need this route.

### The fetch shim

With `shim: { fetch: true }` in the manifest, the platform adds a small script
to your HTML. It patches `fetch` and `XMLHttpRequest` so calls to granted
origins are routed through `/_api/fetch/<url>` automatically. This helps when
porting code that already calls a third-party API directly. In new code, write
the `/_api/fetch/` path yourself: it is explicit, and it works without the shim.
The older spelling `fetch.shim: true` still works.

## Background jobs

`/_api/jobs/*` starts platform-provided work that keeps running after the page
closes, such as a fetch whose JSON result you collect later. Your app submits
the job, polls its status, reads the result, and can cancel it. See
[Background jobs](/apps/jobs).

## Offline

An app can ask the platform for a service worker so it starts with no network.
See [Offline](./serving-and-csp#offline) for the build changes that requires.

## What to build with

The [example apps](https://github.com/AZX-PBC-OSS/helix/tree/main/examples)
are small, deployable references for each capability:

| Example | Shows |
| --- | --- |
| `hello-world` | The smallest deployable bundle |
| `chatbot` | Streaming an LLM through the gateway |
| `waitlist` | A public app with a write-only collection |
| `oversell` | The compare-and-swap write pattern |
| `fetch-proxy` | Calling the GitHub API with an injected key |
| `offline` | The offline service worker |
