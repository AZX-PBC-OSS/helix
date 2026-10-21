---
title: The dev gateway
description: "Calling the real Helix gateway — LLM, app data, fetch proxy, manifest enforcement — from a local dev server or browser-based builder before deploying, against an isolated dev partition."
---

# The dev gateway

With the dev gateway, you can build against the **real** platform while the app
still runs on your laptop or in a browser-based builder. That includes the
real LLM proxy, app data, fetch proxy, and manifest checks.

The dev gateway serves a separate `dev` partition of your app, with its own
data, budget, and credentials. Nothing you do there affects production.

It is **optional for each deployment**. `helix capabilities` shows its base URL
when your deployment runs it, and shows "not deployed" otherwise.

## Setting it up

In the portal:

1. **Create the app and grant its capabilities.** The manifest is enforced in
   dev too, so you find a missing grant now rather than after promoting.
2. **On the app's Dev mode tab, register the exact origins** your dev
   environment loads from, such as `http://localhost:5173` or
   `https://<preview>.your-builder.app`. Wildcards aren't allowed. Then create a
   **dev token**, which is shown only once.
3. **If the app uses a secret-backed `connection`,** add a dev-tier credential
   on the **Secrets** tab.

## Calling it

Point your calls at the dev gateway instead of `/_api/*`. Two things change:

- the slug moves into the URL path;
- the dev token replaces the session cookie.

Everything else about the request is the same. Keep the base URL in one constant
and switch it at build time:

```js
const API = import.meta.env.DEV ? "https://dev-api.example.com/<slug>" : "";

await fetch(`${API}/_api/llm/chat`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(API && { authorization: `Bearer ${import.meta.env.VITE_HELIX_DEV_TOKEN}` }),
  },
  body: JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] }),
});
```

Deploying moves **code**, never data. You can't copy dev data to production,
and the portal can reset the dev partition when you want a clean start.

Connecting a user account in dev works a little differently; see
[Connected accounts](./connected-accounts#in-the-dev-gateway).

Background jobs started through the dev gateway are dev jobs. They are kept
apart from production jobs, and they are counted separately; see
[Developing with the dev gateway](./jobs#developing-with-the-dev-gateway).
