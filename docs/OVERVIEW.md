# AZX Helix — System Overview

**What it is, what it solves, and how it's built.** A single-file orientation for anyone — product,
security, or engineering — meeting the platform for the first time. Deeper detail lives in
[`docs/platform-architecture.md`](platform-architecture.md), the per-decision records in
[`docs/adr/`](adr/), and the per-feature docs in [`docs/features/`](features/).

> **Status (2026-06):** working end-to-end **locally** (milestone M4.5). The Azure production
> deploy (M5) is in progress. Where a capability isn't fully delivered yet, this doc says so.

---

## 1. The problem

A non-engineer builds a working prototype with AI tools (Lovable, Cursor, Claude, v0). Today, getting
it in front of a client or stakeholder means pulling in DevOps: hosting, a URL, sign-in, API keys,
rate limits, audit. So the prototype dies on a laptop — or it ships with an API key pasted into the
bundle and no access control at all.

**Helix is secure hosting for vibe-coded AI apps.** A business user uploads a static frontend and gets
a governed, signed-in URL in minutes — with platform-managed credentials, per-app policy, metering,
and audit — without touching infrastructure. A platform administrator gets the control surface
(vault, policy, audit, identity) that makes that safe to allow.

The whole design rests on **one stance: every hosted app is untrusted code.** Helix does not try to
verify what an app does; it **contains the blast radius of each app** so that a hostile or buggy app
can harm only itself.

---

## 2. Who it's for (from the Phase-1 user stories)

| Persona | What they need |
|---|---|
| **Business user** (non-IT prototype builder) | Upload a bundle → secure URL; pick SSO or password access; call AI/APIs without handling keys; roll back; see usage. |
| **Platform administrator** (IT / security) | One vault for all keys + client tokens; embed a client's *own* licensed API contracts; restrict which models/capabilities each app can use; a tamper-evident audit log of every AI call; manage builders via Entra groups; spend alerts; warehouse export. |
| **End user** (uses a hosted app) | A working experience behind sign-in, with a useful fallback when the AI is down. |

**First apps:** migrate the Trilliant demos onto the platform, then build new ones on it (e.g. the
*Heatwave DR Simulation* — a compute-heavy, no-persistence energy model). These validate static
frontend + governed LLM/compute access with no app-managed secrets.

### How the stories map to what's built

| Story (priority) | How Helix delivers it | Status |
|---|---|---|
| Upload a bundle → secure hosted URL (P0) | Upload-only deploy → immutable version → served at `<slug>.azx.helix.azxlabs.io` | ✅ Shipped |
| SSO (Entra) **or** password per deployment (P0) | Per-app *visibility*: `groups` (OIDC/Entra) · `password` (shared passphrase) · `public` | ✅ Shipped |
| Use pre-provisioned APIs without handling keys (P0) | LLM gateway (key injected server-side) + fetch-proxy with secret-backed *connections* for other APIs | ✅ LLM + arbitrary HTTP APIs; ⚠️ only Anthropic is a first-class LLM today (Azure OpenAI/Gemini are config, not yet a catalog) |
| Roll back a deployment (P1) | Live pointer flip to a prior immutable version (same op as promote) | ✅ Shipped |
| Usage metrics — sessions, errors, latency (P1) | Per-app + per-gateway usage dashboards over the metering ledger | ⚠️ Tokens/requests/outcome shipped; **latency & error-detail are deliberately not recorded** |
| One vault for all keys + client tokens (P0) | `SecretStore` custody seam (prod Key Vault / dev envelope); portal write-only secret management | ✅ Shipped (Key Vault wiring is M5) |
| Embed a client org's own licensed tokens (P0) | Secret *connections*: `app`-scoped and `global` (granted per app); the app's calls use the client's contract, never an AZX key | ✅ Shipped |
| Restrict which models/capabilities each team can use (P0) | Capability manifest + approval classifier (model allowlist, budgets, origins) enforced at the gateway | ✅ Per-**app**; ⚠️ "per-team" grouping isn't a first-class concept (one org, app-id partitioning) |
| Tamper-evident audit log of every AI call (P0) | Append-only `gateway_calls` ledger; `helix_edge` has INSERT-only | ⚠️ Append-only **by DB grant**, not cryptographically tamper-evident — an immutable sink is deferred |
| Provision/deprovision builders via Entra groups (P0) | Group visibility re-checked per request; admin gated on a `platform-admin` group claim | ✅ Mechanism shipped; real Entra registration is the M3 tail / M5 |
| Alerts on spend/usage thresholds (P1) | Budgets *block* over-limit calls | ❌ Hard budget yes; proactive **alerting** not built |
| Export audit/usage to a warehouse (P2) | — | ❌ Not built (P2) |
| End-user fallback when AI is down (P1) | Gateway surfaces structured error/`event: error`; the app renders the fallback | ⚠️ Platform surfaces failures; the fallback UX is app-side |

---

## 3. Architecture at a glance

Helix is **three deployable containers plus managed storage**, split along the trust boundary. The
split is the security model made physical: the data plane faces untrusted users, the control plane
holds the privileged verbs, and the mechanism plane holds the two things most dangerous to co-locate
with a public-facing process — *plaintext third-party secrets* and *a route to the open internet*.

```
 app users ── HTTPS ─▶ *.azx.helix.azxlabs.io
                       ┌──────────────────────────────────────────────┐
                       │ azx-edge — data / policy plane (stateless)   │
                       │ host routing · sessions + OIDC handoff       │
                       │ CSP injection · static serving from Blob     │
                       │ /_api/* gateway: LLM · app-data · fetch-proxy │
                       │ (authz · quota · metering · audit)           │
                       └──┬──────────┬───────────┬──────────────┬─────┘
                          ▼          ▼           ▼              ▼ signed
                     Blob storage  LLM        Postgres      attested
                     (versioned    vendors    (registry·    instruction
                      bundles)    (via egress) app-data·         │
                                              sessions·          ▼
                                              audit)   ┌───────────────────────────┐
                                                       │ azx-egress — mechanism    │
                                                       │ plane (own egress zone)   │
                                                       │ resolve+inject secret ·   │
                                                       │ SSRF controls · outbound  │
                                                       └─────┬───────────┬─────────┘
                                                             ▼           ▼
                                                       third-party   Key Vault
                                                       APIs          / secret store

 app owners ─ HTTPS ─▶ portal.azx.helix.azxlabs.io
                       ┌──────────────────────────────────────────────┐
                       │ azx-portal — control plane (privileged)      │
                       │ portal UI + API · deploy · registry writes   │
                       │ capability approvals · secret writes · audit │
                       └──────────────────────────────────────────────┘
```

- **`azx-edge` — data/policy plane.** Stateless; terminates all untrusted app-user traffic. Host
  routing, session auth, CSP, static serving from Blob, and the `/_api/*` gateway *policy* (identity,
  authorization, quota, audit). Runs as a least-privilege Postgres role with **no app-connection-secret
  read** (no grant on `app_secrets`) and **no arbitrary outbound** — it can only ask egress to make
  calls it has already authorized. (It is not secretless: it holds its own operational keys — auth,
  instruction, OIDC — and today an over-broad Blob key; see [ADR-0001](adr/0001-three-runtime-split.md).)
- **`azx-portal` — control plane.** Privileged: portal UI/API, deploys, registry writes, capability
  approvals, secret writes. Owns the Postgres schema and migrations. Not routable from app subdomains.
- **`azx-egress` — mechanism plane.** The only component holding plaintext connection secrets or a
  route to the public internet. Internal-only: it verifies the edge's signed instruction, resolves +
  injects the secret server-side, enforces SSRF controls, and streams the call back.
- **Storage:** Postgres (registry, app-data, sessions, audit), Blob (immutable versioned app bundles),
  Key Vault (secrets, prod).

### The request lifecycle

1. **Deploy.** An owner (portal UI or `azx` CLI) uploads a static bundle. It becomes an **immutable
   version** in Blob and lands as `preview`. Promotion to `live` is a separate **atomic pointer flip**;
   rollback is the same flip in reverse. *(ADR-0018)*
2. **Serve.** A visitor hits `<slug>.azx.helix.azxlabs.io`. The edge resolves the slug from an in-memory
   **registry projection** (a cache refreshed via Postgres LISTEN/NOTIFY — no per-request DB, and it
   survives portal downtime), then streams the bundle from Blob with a per-app CSP injected. *(ADR-0017,
   0009)*
3. **Authenticate.** Per-app visibility decides access: an OIDC login on `auth.azx.helix.azxlabs.io` mints a
   one-time signed **handoff** that crosses to the app's own subdomain and sets a `__Host-` session
   cookie; or a shared **password** challenge; or **public**. Subdomain-per-app + host-scoped cookies
   mean no app can read another's session. *(ADR-0004, 0019)*
4. **Use a capability.** The app calls the gateway **same-origin** at `/_api/*` (no CORS, no token in
   app JS — the cookie just works). The edge authorizes the call against the app's **capability
   manifest** (model allowlist, daily budget, allowed fetch origins), meters it, and — for anything
   touching a secret or the internet — mints a short-lived **signed instruction** and forwards it to
   **egress**, which injects the credential and makes the outbound call. The app never sees a key.
   *(ADR-0014, 0016, 0005, 0013)*

---

## 4. The security model, in five mechanisms

1. **Per-app origin isolation.** Every app on its own subdomain with `__Host-` cookies → the browser's
   same-origin policy is the isolation primitive; one app cannot touch another's session, storage, or
   DOM. *(ADR-0019)*
2. **The gateway is the only dynamic surface.** Apps are static (ADR-0020); all dynamic power (LLM,
   storage, third-party HTTP) flows through the same-origin `/_api/*` choke point, where identity,
   authorization, quota, and audit are enforced once. *(ADR-0014)*
3. **Secrets never reach the app — or the edge.** The control plane writes secrets; only the isolated
   egress plane resolves them to plaintext and injects them server-side. A compromise of the
   public-facing edge reaches no third-party credential. *(ADR-0006, 0005, 0013)*
4. **Capabilities are governed, not assumed.** A manifest declares each app's grants; privilege
   *reductions* commit immediately, *increases* gate on platform-admin approval. The edge only ever
   sees effective state. *(ADR-0016)*
5. **Database-enforced least privilege.** The edge runs as a distinct least-privilege role
   (`helix_edge`); app-data is Row-Level-Security-partitioned per user; collections are INSERT-only (an
   app can write but never read back others' entries — defeating data-harvesting); metering is
   append-only by grant. The process split is re-enforced inside the database. *(ADR-0002, 0015, 0021)*
   *(Caveat, ADR-0002: the split isn't fully realized — the portal connects as the schema owner, and the
   edge falls back to the owner DSN if its role DSN is unset; both tracked to be hardened before M5.)*

Honest residual: relaxed CSP (necessary for vibe-coded bundles) gives up XSS prevention by design, and
granted channels (LLM prompts, approved origins, navigation) remain possible exfil paths — containment
raises the bar, it does not eliminate every channel. Open hardening items are tracked as GitHub issues
and in [`docs/reviews/`](reviews/).

---

## 5. Where the decisions live

The **26 Architecture Decision Records** in [`docs/adr/`](adr/) are the canonical record of *why*.
Foundational set:

- **Trust boundary & isolation:** 0001 three-plane split · 0019 subdomain-per-app · 0020 static-only
  apps · 0014 same-origin gateway · 0002 Postgres role split + RLS.
- **Secrets & egress:** 0006 custody seam · 0005 SSRF + injection · 0013 egress trust model · 0008 LLM
  key via egress.
- **Governance & data:** 0016 capability manifest + approval classifier · 0015 app-data three scopes ·
  0021 metering ledger · 0007 portal authz (v0).
- **Platform shape:** 0017 registry projection (· 0025 projection hardening) · 0018 deploy model (· 0026
  hosted-build isolation prerequisites) · 0022 self-hosted edge · 0023 one-org + app-id partitioning ·
  0012 edge/portal co-deploy · 0003 dependency-minimal edge.
- **Auth & access:** 0004 app-user auth · 0024 portal/CLI auth · 0009 relaxed CSP · 0010 anonymous
  shared-writes · 0011 in-memory rate limiting.

Deeper design and feature docs: [`docs/design/`](design/) (app-data, approvals, fetch-proxy,
secrets-and-connections) and [`docs/features/`](features/) (one per shipped capability).

---

## 6. What's next

- **M5 — Azure deploy:** Container Apps, Key Vault custody wired in prod, real Entra app registration,
  the production network zones that make the egress isolation physical.
- **Known hardening before the pilot:** the open security issues (instruction replay/scope, edge↔egress
  TLS, portal per-app authorization, rate-limit-across-replicas) — see the GitHub issue tracker.
- **Capability catalog:** additional first-class LLM providers (Azure OpenAI, Gemini) and curated API
  endpoints (geocoding) behind the existing provider/connection seams.
- **Admin depth:** spend/usage **alerting** (P1) and **warehouse export** (P2) of audit/usage data.
