# Dev mode — developing an app against Helix

> **Related ADRs:** [ADR-0002](../adr/0002-postgres-role-split-rls.md) (role split + RLS — the isolation) · [ADR-0013](../adr/0013-egress-trust-model.md) (egress trust model) · [ADR-0028](../adr/0028-deployment-model-customer-deployed.md) (single-tenant, customer-deployed). The _why_ and the full design live in [`../design/dev-mode.md`](../design/dev-mode.md); this doc is the **how, today**.

**What it is.** A way to develop an app _against the real platform_ — its LLM proxy, app-data, fetch-proxy, manifest, and capability approvals — while the app is still being written **somewhere else** (localhost, Lovable, a cloud IDE), before it's ever deployed. Instead of relaxing production's walls, dev mode gives the app a **second, isolated environment**: a `dev` data partition on the _same app_, with its own data, budget, and secrets, reached through a dedicated surface. The whole blast radius of dev mode is "one developer's throwaway `env=dev` data and budget," bounded by the database, not by policy.

The core stance (dev-mode design §1): production's gateway is safe _because_ it's cookie-only, exact-Origin-locked, and CORS-free. Dev mode does **not** poke holes in that. It stands up a separate tier — a different principal (you, the developer, holding a token you own), a different DB role, a different data partition — and leaves production untouched.

| Surface | For | Status |
| --- | --- | --- |
| **dev-gateway** (`dev-api.<base>`, `:8082`) — CORS + dev token | Lovable, cloud IDEs, and localhost dev apps | **✅ built** |
| **`helix dev`** — a local same-origin proxy | `localhost` development (nicer DX, no token paste) | _planned (design §3, step 4)_ |
| **client SDK + in-memory mock** | turnkey portability; Claude Artifacts / offline | _planned (design §8, step 5)_ |

Today you develop against Helix through the **dev-gateway**. It works for both cross-origin IDEs (Lovable) and localhost apps.

---

## The workflow (today)

Everything below is control-plane setup in the **portal** plus calls from your in-development app to the dev-gateway. All of it targets `env=dev` — isolated from the live app.

### 1. Create the app (before there's any code)

An app can exist with zero deployed versions. Create it in the portal (or `helix create`) — you get a **slug**, and the **manifest is editable and enforced immediately**, deployed code or not. This is the "draft" state: you develop against `env=dev`, and only later `helix deploy` + promote a real version.

### 2. Grant the capabilities you'll use

In the portal **Capabilities** tab, grant what the app calls: `llm` (with a model allowlist + daily budget), `data` (user / collections / shared), and/or `fetch` (proxied origins). **The manifest is shared between dev and prod** — a capability the app isn't granted 403s in dev too. That's the point: you find the missing grant while developing, not after promoting.

### 3. (Only for secret-backed fetch) configure a dev connection secret

If your app fetches a third-party API through a **connection** (a named secret injected server-side), add a **dev-tier** credential in the portal **Secrets** tab: set **Tier → dev**. A dev fetch injects only `dev` connection secrets and can never resolve a prod one (and vice-versa). You keep dev/test credentials off your laptop and out of Lovable — the platform holds them.

### 4. Register origins and mint a dev token

In the portal **Dev mode** tab:

- **Register the exact origins** your in-development app loads from — e.g. `http://localhost:5173` for a local Vite app, or your `https://<preview>.lovable.app` URL. No wildcards; the dev-gateway reflects CORS only for registered origins.
- **Mint a dev token.** It's shown **once** (`azxdev_…`) — copy it. It's bound to this app, these origins, and `env=dev`; it's revocable and short-lived (default 30 days, rotate to renew).

### 5. Call the dev-gateway from your app

Point your app's Helix calls at the dev-gateway and send the token as a bearer. The app slug is in the **path** (the host is fixed):

```
POST   https://dev-api.local.helix.azxlabs.io:8082/<slug>/_api/llm/chat
GET/PUT/DELETE  …:8082/<slug>/_api/data/user/<key>
POST   …:8082/<slug>/_api/data/collections/<name>
GET/PUT …:8082/<slug>/_api/data/shared/<key>
ANY    …:8082/<slug>/_api/fetch/<url>

Authorization: Bearer azxdev_…
Origin: http://localhost:5173      # (the browser sets this)
```

The request shape is **identical to production's `/_api/*`** — same verbs, same bodies — so the only difference between dev and prod is the base URL + the token. (A `curl` smoke:)

```bash
curl -k -X PUT https://dev-api.local.helix.azxlabs.io:8082/<slug>/_api/data/user/todo \
  -H "Authorization: Bearer azxdev_…" -H "Origin: http://localhost:5173" \
  -H "content-type: application/json" -d '["milk","eggs"]'
```

### 6. Promote when ready — code moves, dev data never does

`helix deploy` a version and promote it (registry + deploys). Production then serves the app at `https://<slug>.local.helix.azxlabs.io:8080/` behind SSO, under the **same manifest** you developed against. Promotion moves **code** (the version pointer), never data — there is deliberately no "copy my dev rows to prod." The portal offers a **"clear dev data"** reset for the throwaway `env=dev` partition.

---

## Isolation — why this is safe

- **The database refuses to cross the boundary.** `env=dev` rows are readable/writable only by the `helix_dev` role, whose RLS policy **hardcodes `env='dev'`** (and the production `helix_edge` role is pinned to `env='prod'`). Independent of any request parameter, header, or bug — a compromised dev-gateway cannot read or write a single production row, and vice-versa (ADR-0002; design §5.3).
- **The dev-gateway is a separate process** running as `helix_dev` only — it never holds the production data-plane role's credentials.
- **The dev token is bounded and revocable:** one app, `env=dev` only, origin-pinned, stored only as a hash, flipped off from the portal at any time. A leaked dev token reaches one app's throwaway dev tier as one developer — no prod data, ever.
- **Budgets are per-env:** hammering the LLM in dev burns the dev budget window, never the live app's.

---

## Running it locally

The dev-gateway is **opt-in** and off by default; the dev container turns it on (`EDGE_ALLOW_DEV_MODE=true`) and points it at the `helix_dev` role (`EDGE_DEV_DATABASE_URL`).

```bash
pnpm dev:portal   # :3001 — mint tokens / register origins / configure secrets (or via the SPA)
pnpm dev:web      # :5173 — the portal SPA (Dev mode + Secrets tabs)
pnpm dev:devgw    # :8082 — the dev-gateway (HTTPS, runs as helix_dev, routes to env=dev)
pnpm dev:egress   # :8081 — only if you exercise /_api/fetch or connections
```

`dev-api.local.helix.azxlabs.io` resolves to `127.0.0.1`, and the mkcert wildcard cert covers it. **Cross-origin from a browser** (e.g. a Vite app on `http://localhost:5173`) needs the mkcert CA trusted by that browser — accept the cert once, or import `.devcontainer/certs/caroot/rootCA.pem` (same as any app host). CORS for registered origins is handled by the gateway.

> **Existing dev container?** `helix_dev` is created by `.devcontainer/db-init/01-roles.sql`, which only runs on a **fresh** DB volume. If your volume predates dev mode, recreate it (`docker compose down -v`, rebuild) and run `pnpm --filter @azx-pbc/portal db:deploy` — a plain rebuild won't create the role.

---

## Planned / not yet built

- **`helix dev`** — a local same-origin proxy so `localhost` development uses your `helix login` token ambiently (no token paste, no CORS). Today localhost works through the dev-gateway instead. (design §3/§4.2, step 4)
- **Client SDK + in-memory mock + impersonation** — `helix.llm.chat()`-style calls with a swappable transport so app source is identical across prod / localhost / dev-gateway / mock; the mock is the only way to reach Claude Artifacts (sandbox CSP blocks the gateway); `X-Helix-Dev-As` for testing as multiple synthetic users. (design §8/§4.3, step 5)
- **Before enabling the surface in a real (non-local) deployment:** a short-window throttle on the dev-gateway itself, a distinct dev LLM budget (the vendor key is env-agnostic — design §11), and host/TLS wiring for `dev-api.<base>`. _(The `EDGE_TRUST_PROXY` half of that rider is done — the hop count is verified and passed to the dev-gateway container, so a throttle added here keys on the real client IP.)_
- **Dev _global_ connection secrets** — dev connection secrets are app-scoped today; a dev fetch bound to a shared **global** connection is a documented gap.
