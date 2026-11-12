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

Everything else about the request is the same. The token is scoped to the dev
partition and checked against the origins you registered; it cannot call the
production partition or an unregistered origin.

**With a dev server, relay `/_api/*` through the dev server.** This is the
recommended pattern for local development. The dev server forwards `/_api/*` to
the dev gateway and adds the `authorization` header itself, from an environment
variable read on the server side. The token never lands in a bundle, and the
app code calls `/_api/*` exactly as it will in production:

```ts
// vite.config.ts
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    server: {
      proxy: {
        "/_api": {
          target: "https://dev-api.example.com",
          changeOrigin: true,
          rewrite: (path) => `/<slug>${path}`,
          headers: {
            authorization: `Bearer ${env.HELIX_DEV_TOKEN ?? ""}`,
            origin: "http://localhost:5173",
          },
        },
      },
    },
  };
});
```

The dev gateway checks the `Origin` header against the origins you registered,
and browsers send no `Origin` on a same-origin `GET`. The relay therefore sets
it, so register your dev server's origin (here `http://localhost:5173`) on the
**Dev mode** tab.

Put the token in `.env.local` as `HELIX_DEV_TOKEN` — no `VITE_` prefix. Vite
only inlines `VITE_`-prefixed variables into bundles, so anything else stays on
the dev-server side. **A `VITE_`-prefixed variable is inlined into every bundle
that imports it, and a test runner that loads the same env file will route its
tests at the dev gateway** — neither is what you want.

Without a dev server — a **browser-based builder** — there is nothing to run a
relay in, so the token has to reach the browser. Keep the base URL in one
constant and switch it at build time:

```js
const API = import.meta.env.DEV ? "https://dev-api.example.com/<slug>" : "";

await fetch(`${API}/_api/data/user/settings`, {
  headers: {
    ...(API && { authorization: `Bearer ${import.meta.env.VITE_HELIX_DEV_TOKEN}` }),
  },
});
```

For language models, the OpenAI SDK sends its `apiKey` as exactly that bearer
header, so the dev token goes in `apiKey`. In production the key is ignored and
the session cookie authenticates:

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: `${API || location.origin}/_api/openai/v1`,
  apiKey: API ? import.meta.env.VITE_HELIX_DEV_TOKEN : "unused",
  dangerouslyAllowBrowser: true,
});
```

Deploying moves **code**, never data. You can't copy dev data to production,
and the portal can reset the dev partition when you want a clean start.

Connecting a user account in dev works a little differently; see
[Connected accounts](./connected-accounts#in-the-dev-gateway).

Background jobs started through the dev gateway are dev jobs. They are kept
apart from production jobs, and they are counted separately; see
[Developing with the dev gateway](./jobs#developing-with-the-dev-gateway).
