# AZX Helix — System Overview

**What it is, what it solves, and how it's built.** A single-file orientation for anyone — product,
security, or engineering — meeting the platform for the first time. Deeper detail lives in
[`docs/platform-architecture.md`](platform-architecture.md), the per-decision records in
[`docs/adr/`](adr/), and the per-feature docs in [`docs/features/`](features/).

> **Status (2026-08):** **deployed and running on Azure** — the three planes on Container Apps,
> real Entra OIDC, wildcard TLS, and Key Vault custody verified against a live vault (M5).
> Outstanding: a real pilot app end to end. Where a capability isn't fully delivered yet, this
> doc says so — but the authority on exact done/partial/deferred status is
> [`platform-project-plan.md`](platform-project-plan.md), and on how a shipped feature works
> today, [`features/`](features/). This doc is orientation, not a status tracker.

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

## 2. Who it's for

| Persona | What they need |
|---|---|
| **Business user** (non-IT prototype builder) | Upload a bundle → secure URL; pick SSO or password access; call AI/APIs without handling keys; roll back; see usage. |
| **Platform administrator** (IT / security) | One vault for every key and third-party token; let an app spend an organisation's *own* licensed API contract without ever holding it; restrict which models and capabilities each app can use; an audit log of every AI call; manage builders via Entra groups; spend alerts; warehouse export. |
| **End user** (uses a hosted app) | A working experience behind sign-in, with a useful fallback when the AI is down. |

The first two personas are the reason the platform is shaped the way it is: the business user's
needs are all *self-serve*, and the administrator's are all *centrally enforced*. Everything in §3
and §4 follows from serving both at once — which is why the app is static and the **gateway** is
where the power and the policy meet.

**Where each of those stands today** is the project plan's job, not this doc's — see
[`platform-project-plan.md`](platform-project-plan.md) §5 for the per-milestone status and
[`../TODO.md`](../TODO.md) for the open follow-ups. In one line: the mechanisms for the
administrator's list exist and run in production; the depth (per-team policy, cryptographic
tamper-evidence, spend alerting, warehouse export) is where the gaps are, and §6 names them.

---

## 3. Architecture at a glance

Helix is **three deployable containers plus managed storage**, split along the trust boundary. The
split is the security model made physical: the data plane faces untrusted users, the control plane
holds the privileged verbs, and the mechanism plane holds the two things most dangerous to co-locate
with a public-facing process — *plaintext third-party secrets* and *a route to the open internet*.

```
 app users ── HTTPS ─▶ *.azx.helix.azxlabs.io
                       ┌──────────────────────────────────────────────┐
                       │ helix-edge — data / policy plane (stateless) │
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
                                                       │ helix-egress — mechanism  │
                                                       │ plane (own egress zone)   │
                                                       │ resolve+inject secret ·   │
                                                       │ SSRF controls · outbound  │
                                                       └─────┬───────────┬─────────┘
                                                             ▼           ▼
                                                       third-party   Key Vault
                                                       APIs          / secret store

 app owners ─ HTTPS ─▶ portal.azx.helix.azxlabs.io
                       ┌──────────────────────────────────────────────┐
                       │ helix-portal — control plane (privileged)    │
                       │ portal UI + API · deploy · registry writes   │
                       │ capability approvals · secret writes · audit │
                       └──────────────────────────────────────────────┘
```

- **`helix-edge` — data/policy plane.** Stateless; terminates all untrusted app-user traffic. Host
  routing, session auth, CSP, static serving from Blob, and the `/_api/*` gateway *policy* (identity,
  authorization, quota, audit). Runs as a least-privilege Postgres role with **no app-connection-secret
  read** (no grant on `app_secrets`) and **no arbitrary outbound** — it can only ask egress to make
  calls it has already authorized. (It is not secretless: it holds its own operational keys — auth,
  instruction, OIDC — but the over-broad Blob account key ADR-0001 flagged as a P0 is gone: Blob reads
  go out under a **managed identity** in production, with the hand-signed key path confined to
  dev/Azurite. See [ADR-0001](adr/0001-three-runtime-split.md), [ADR-0027](adr/0027-blob-auth-managed-identity.md).)
- **`helix-portal` — control plane.** Privileged: portal UI/API, deploys, registry writes, capability
  approvals, secret writes. Owns the Postgres schema and migrations. Not routable from app subdomains.
- **`helix-egress` — mechanism plane.** The only component holding plaintext connection secrets or a
  route to the public internet. Internal-only: it verifies the edge's signed instruction, resolves +
  injects the secret server-side, enforces SSRF controls, and streams the call back.
- **Storage:** Postgres (registry, app-data, sessions, audit), Blob (immutable versioned app bundles),
  Key Vault (secrets, prod).

### The request lifecycle

1. **Deploy.** An owner (portal UI or `helix` CLI) uploads a static bundle. It becomes an **immutable
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
   *(Caveat, ADR-0002: the portal still connects as the schema owner. The edge's owner-DSN fallback is
   closed — `EDGE_DATABASE_URL` (the `helix_edge` role) is **required** in production and the edge refuses
   to start on the `DATABASE_URL` fallback, which would bypass RLS; the Azure deploy passes it explicitly.)*

Honest residual: relaxed CSP (necessary for vibe-coded bundles) gives up XSS prevention by design, and
granted channels (LLM prompts, approved origins, navigation) remain possible exfil paths — containment
raises the bar, it does not eliminate every channel. Open hardening items live in
[`TODO.md`](../TODO.md) (distilled from the ADRs, with the gating condition on each) and in the
GitHub issue tracker; the review passes they came out of are in [`docs/reviews/`](reviews/).

---

## 5. Where the decisions live

The **35 Architecture Decision Records** in [`docs/adr/`](adr/) are the canonical record of *why* —
where an ADR and older prose disagree, the ADR wins. Foundational set:

- **Trust boundary & isolation:** 0001 three-plane split · 0019 subdomain-per-app · 0020 static-only
  apps · 0014 same-origin gateway · 0002 Postgres role split + RLS.
- **Secrets & egress:** 0006 custody seam · 0005 SSRF + injection · 0013 egress trust model · 0008 LLM
  key via egress · 0027 Blob via managed identity · 0029 platform secret delivery · 0031 connection
  providers / delegated auth.
- **Governance & data:** 0016 capability manifest + approval classifier · 0015 app-data three scopes ·
  0021 metering ledger · 0007 portal authz (v0).
- **Platform shape:** 0017 registry projection (· 0025 projection hardening) · 0018 deploy model (· 0026
  hosted-build isolation prerequisites · 0030 repo-backed apps) · 0022 self-hosted edge · 0023 one-org +
  app-id partitioning · 0012 edge/portal co-deploy · 0003 dependency-minimal edge · 0028 customer-deployed
  model · 0032 CLI naming + distribution.
- **Auth & access:** 0004 app-user auth · 0024 portal/CLI auth · 0009 relaxed CSP · 0010 anonymous
  shared-writes · 0011 rate limiting (now a shared Postgres counter).
- **App-facing surface:** 0033 OpenAI-compatible gateway + multi-provider routing · 0034 structured
  output · 0035 offline capability (a platform-owned, scope-confined service worker).

Deeper design and feature docs: [`docs/design/`](design/) (app-data, approvals, fetch-proxy,
secrets-and-connections, custom backends) and [`docs/features/`](features/) (one per shipped
capability). [`docs/README.md`](README.md) maps the whole tree.

---

## 6. What's next

- **A real pilot app end to end** — the last outstanding M5 exit criterion, and the only evidence
  that isn't self-referential. The Azure deploy itself has landed: Container Apps, Key Vault custody
  verified against a live vault, real Entra, and the production network zones that make the egress
  isolation physical.
- **Known hardening:** portal **per-app RBAC** (owner/editor/viewer — the BOLA half is closed, reads
  are still authenticated-only), **channel-level defense on the edge→egress hop** (mTLS / workload
  identity — the hop is authenticated by a signed, single-use, audience-bound instruction, not by the
  channel), a **session-revocation / admin-kill path**, and moving untrusted apps onto their own
  registrable domain before external URLs commit. Instruction replay and per-action scope are closed
  (ADR-0013 steps 1–2), as is rate limiting across replicas (a shared Postgres counter, ADR-0011).
  The full list is [`TODO.md`](../TODO.md).
- **Capability catalog:** Anthropic and OpenAI-compatible upstreams are both wired today (ADR-0033) —
  next is making additional vendors and curated endpoints (e.g. geocoding) *first-class catalog
  entries* rather than per-deployment connection config.
- **Admin depth:** spend/usage **alerting** (the dollar data it needs is now recorded) and
  **warehouse export** of audit/usage data.
