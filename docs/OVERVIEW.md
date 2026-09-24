# AZX Helix — System Overview

Helix hosts AI-generated web apps with platform-managed access control,
credentials, storage, and usage limits. This overview introduces the product
and its security model. See the [project plan](platform-project-plan.md) for
status and [feature docs](features/) for implementation details.

Helix runs on Azure Container Apps with Entra OIDC, wildcard TLS, and Key Vault.
It also runs locally for development.

## 1. The problem

AI tools make it easier to build a frontend, but sharing it still requires
hosting, sign-in, API credentials, usage limits, and audit. Helix supplies those
services: an owner uploads a static bundle and configures its access and API
permissions through the portal.

Every hosted app is treated as untrusted code. Helix restricts each app's access
to data, credentials, other apps, and external services. It does not verify that
the app behaves correctly.

---

## 2. Who it's for

| Persona | What they need |
|---|---|
| **Business user** (non-IT prototype builder) | Upload a bundle → secure URL; pick SSO or password access; call AI/APIs without handling keys; roll back; see usage. |
| **Platform administrator** (IT / security) | One vault for every key and third-party token; let an app spend an organisation's *own* licensed API contract without ever holding it; restrict which models and capabilities each app can use; an audit log of every AI call; manage builders via Entra groups; spend alerts; warehouse export. |
| **End user** (uses a hosted app) | A working experience behind sign-in, with a useful fallback when the AI is down. |

Owners manage their apps through self-service workflows; administrators set and
enforce platform policy. See [project plan §5](platform-project-plan.md) and
[TODO.md](../TODO.md) for remaining work on these workflows.

---

## 3. Architecture at a glance

Three services separate app traffic, administration, and outbound requests.
The edge handles untrusted traffic; the portal manages privileged changes;
egress holds connection credentials and makes third-party API calls.

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

- **Edge:** routing, authentication, static serving, CSP, and gateway policy.
  Its database role cannot read app connection secrets. It holds operational
  auth/signing credentials and uses a read-only Blob managed identity in production
  ([ADR-0001](adr/0001-three-runtime-split.md),
  [ADR-0027](adr/0027-blob-auth-managed-identity.md)).
- **Portal:** UI/API, deploys, registry updates, approvals, and secret writes.
  Owns schema migrations and is not routed through app subdomains.
- **Egress:** verifies signed edge instructions, injects credentials, applies
  SSRF controls, and streams outbound responses. It is internal-only.
- **Storage:** Postgres for registry, app data, sessions, and audit; Blob for
  immutable bundles; Key Vault for production credentials.

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

1. **Separate origins.** Each app has its own subdomain and host-only `__Host-`
   cookie. Browser origin rules separate DOM and storage; gateway Origin checks
   protect against sibling-app requests. (ADR-0019)
2. **Gateway authorization.** Static apps use `/_api/*` for server-side work.
   The gateway checks identity, capability grants, quotas, and audit. (ADR-0014, 0020)
3. **Isolated connection secrets.** The portal stores credentials; egress resolves
   and injects them. The edge's database role cannot read them. (ADR-0005, 0006, 0013)
4. **Approved capabilities.** Baseline changes apply immediately; elevated grants
   require admin approval. The edge sees only effective settings. (ADR-0016)
5. **Database permissions.** Separate runtime roles limit table access. RLS scopes
   app data; collection writes and metering use restricted grants. Production
   requires role-specific database URLs, separate from the migration owner.
   (ADR-0002, 0015, 0021)

The relaxed CSP supports generated bundles but does not prevent all XSS or data
exfiltration. Navigation, HTTPS images, LLM prompts, and approved external origins
remain possible channels. A permitted API can also be misused within its grant.
See [TODO.md](../TODO.md) for hardening work and [reviews](reviews/) for dated findings.

---

## 5. Where the decisions live

The Architecture Decision Records in [`docs/adr/`](adr/) are the canonical record of *why* —
where an ADR and older prose disagree, the ADR wins. Foundational set:

- **Trust boundary & isolation:** 0001 three-plane split · 0019 subdomain-per-app · 0020 static-only
  apps · 0014 same-origin gateway · 0002 Postgres role split + RLS.
- **Secrets & egress:** 0006 custody seam · 0005 SSRF + injection · 0013 egress trust model · 0008 LLM
  key via egress · 0027 Blob via managed identity · 0029 platform secret delivery · 0031 connection
  providers / delegated auth.
- **Governance & data:** 0016 capability manifest + approval classifier · 0015 app-data three scopes ·
  0021 metering ledger · 0007 portal authz (v0).
- **Platform shape:** 0017 registry projection (· 0025 projection hardening) · 0018 deploy model (· 0026
  hosted-build isolation prerequisites · 0030 repo-backed apps · 0038 malformed-bundle salvage in the
  SPA) · 0022 self-hosted edge · 0023 one-org + app-id partitioning · 0012 edge/portal co-deploy · 0003
  dependency-minimal edge · 0028 customer-deployed model · 0032 CLI naming + distribution.
- **Auth & access:** 0004 app-user auth · 0024 portal/CLI auth · 0009 relaxed CSP · 0010 anonymous
  shared-writes · 0011 rate limiting (now a shared Postgres counter).
- **App-facing surface:** 0033 OpenAI-compatible gateway + multi-provider routing · 0034 structured
  output · 0035 offline capability (a platform-owned, scope-confined service worker).

Deeper design and feature docs: [`docs/design/`](design/) (app-data, approvals, fetch-proxy,
secrets-and-connections, custom backends) and [`docs/features/`](features/) (one per shipped
capability). [`docs/README.md`](README.md) maps the whole tree.

---

## 6. What's next

- **End-to-end pilot:** validate deploy, sign-in, and gateway use with a real app.
  Also confirm that the optional egress firewall is enabled in live deployments.
- **Hardening:** owner/editor/viewer roles, stronger authentication of the
  edge-to-egress transport, and a separate registrable domain for hosted apps.
  Signed instructions already prevent replay and bind method/path; session
  revocation and shared rate-limit counters have shipped. See [TODO.md](../TODO.md).


- **Capability catalog:** Anthropic and OpenAI-compatible upstreams are both wired today (ADR-0033) —
  next is making additional vendors and curated endpoints (e.g. geocoding) *first-class catalog
  entries* rather than per-deployment connection config.
- **Admin depth:** spend/usage **alerting** (the dollar data it needs is now recorded) and
  **warehouse export** of audit/usage data.
