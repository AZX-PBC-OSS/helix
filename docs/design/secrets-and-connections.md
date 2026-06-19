# AZX App Platform — Secrets & Connections (design doc)

**Status:** Design draft v1 · June 2026
**Companion to:** `platform-architecture.md` (§4.4 "Secrets: Key Vault", §12 "secret-backed connections (v1.x)"), `docs/design/fetch-proxy.md` (the consumer — this doc fills in its `connection` field), `docs/design/approvals.md` (the spine secret-grants ride), `docs/platform-custom-backends-and-apis.md` §4 (the policy-plane/mechanism-plane split this leans on), and the password-credential code (`apps/portal/src/access/password.ts`) — the closest existing precedent.
**Why this exists:** The fetch-proxy (and later MCP passthrough, custom backends) needs a place for third-party credentials to live so the app never holds them. "Put it in Key Vault" (architecture §4.4/§12) names the destination and stops there. This doc designs the system of record, the CRUD surface, the app↔secret binding, the approval integration, and — the load-bearing part — **how a secret reaches the outbound call without the edge becoming a place that can read every app's keys.**

---

## 1. The one thing that must survive

The password-credential pattern (`access/password.ts`) is the obvious template, and it is *almost* right. The portal mints an xkcd passphrase, encrypts it AES-256-GCM under a key HKDF-derived from `PORTAL_SECRET` (`passwordEnc`, for owner re-display), and projects only the scrypt **hash** + salt to the edge (`apps/edge/src/registry/projection.ts` carries `passwordHash`/`passwordSalt`, never `passwordEnc`). The role split holds for free: `helix_edge` can `SELECT passwordHash` and verify a login, and can *never* recover a password, because a hash is one-way and the edge never sees the ciphertext or the key.

**Connection secrets break that, on purpose, because of what they're for.** Verifying a password needs a one-way digest; injecting a GitHub PAT into `Authorization: Bearer …` needs the **plaintext**. You cannot project a hash and inject it. So the property that made password storage clean — *the edge only ever holds a non-reversible derivative* — cannot hold for a credential the platform has to replay outbound. The invariant therefore shifts from "the edge holds nothing reversible" to:

> **An app never receives a connection secret, and the secret reaches plaintext only inside the egress mechanism that makes the outbound call — never in the browser, never in the registry projection, never in the policy code that resolves identity and authz. The system of record is the control plane; the blast radius of plaintext is one narrow, extractable component.**

This is the custom-backends §4 **policy-plane / mechanism-plane** split, made concrete for the first time: the edge *policy* plane (session gate, grant evaluation, quota, audit) stays secret-free; the *egress mechanism* (the thing that calls undici outbound and injects the header) is the only code that touches plaintext, and it runs under its own least-privilege identity so a compromise of the policy edge cannot read keys. Everything below serves that line.

## 2. The model: secrets, connections, grants

Three nouns, kept deliberately distinct:

- **Secret** — opaque credential material (a string: an API key, a PAT, a bearer token). Stored encrypted; never returned to anyone after it's set (§4). Has a **scope**: `app` (usable by one app) or `global` (usable by many, via grants). Carries an **injection recipe** — how this credential is applied to a request (`header-bearer` → `Authorization: Bearer {}`; `header` → arbitrary `{name}: {template}`; `query` → `?{param}={}`). The recipe is a property of the *credential*, because how a key is presented is intrinsic to that key, not to the app using it.
- **Connection** — the binding "outbound calls from *this app* to *this origin* inject *this secret*." This is exactly the `connection` field `docs/design/fetch-proxy.md` §5 gestures at; this doc defines what it points to. A connection lives in the app's manifest (`capabilities.fetch.origins[].connection` → a secret name) and is the unit the fetch-proxy reads.
- **Grant** — for a `global` secret only: a row saying "app X may use secret S." App-scoped secrets need no grant (the owning app may use them); global secrets need an explicit, approval-gated grant per consuming app (§7), so "shared across apps" never means "ambiently available to every app."

Why split secret from connection rather than make one "connection" object that bundles origin+credential+app (the Cloudflare/Outbound-Worker shape)? Because the **global** requirement forces it. A single Stripe key used by six internal apps is *one* secret with *six* connections; bundling would store the key six times (six rotation points, six leak surfaces). One secret, many bindings is the only model that makes "rotate once, all six apps follow" true.

```ts
// packages/shared/src/secrets.ts (new)
export const InjectionRecipeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('header-bearer') }),                 // Authorization: Bearer <secret>
  z.object({ kind: z.literal('header'), name: z.string(), template: z.string().default('{}') }),
  z.object({ kind: z.literal('query'), param: z.string() }),
]);
export const SecretScopeSchema = z.enum(['app', 'global']);
// The manifest side (refines fetch-proxy §5 — `connection` names a secret by name):
//   capabilities.fetch.origins: [{ origin, mode: 'proxy', connection: 'stripe-live' }]
```

## 3. Storage & crypto

Mirror the password envelope, with one deliberate hardening:

- **Encryption at rest.** AES-256-GCM, key HKDF-derived from a dedicated KEK with its own info string (`helix-connection-secret-v1`) — reuse the `PORTAL_SECRET` HKDF machinery from `access/password.ts`, or a separate `PORTAL_SECRETS_KEK` if we want secret material and password material under independent keys (lean: separate KEK — a leaked password key shouldn't unlock connection secrets). Ciphertext is `iv:tag:ciphertext`, exactly the password format.
- **Write-only / rotate-only — *no* re-display.** This is where we diverge from passwords, and it's stricter, not looser. A password is re-displayed (`GET …/access/password` decrypts `passwordEnc`) because a *human* has to read it to share it. An API key has no such need — nothing reads it back, so nothing should be *able* to. You set it, you can rotate it (paste a new value), you can delete it; you can never read it. That removes the entire "decrypt-for-display" code path and the attack surface with it. The owner UI shows metadata only: name, scope, injection kind, `createdBy`, `rotatedAt`, `lastUsedAt`, and which apps are bound.
- **The `SecretStore` seam** (architecture §8 portability rule — "Azure services may appear only behind internal interfaces … secrets"). One interface, two implementations:
  - **dev / local:** ciphertext in Postgres (`app_secrets` table) under the KEK above. Works in the dev container with no Azure dependency, exactly as `passwordEnc` does today.
  - **prod:** Azure Key Vault. The DB row holds only a Key Vault *reference*; the value lives in the vault, fetched via managed identity. Same interface; the swap is config, not a rewrite.

```sql
-- portal-owned migration
CREATE TABLE app_secrets (
  id           UUID PRIMARY KEY,
  scope        TEXT NOT NULL,            -- 'app' | 'global'
  app_id       UUID,                     -- NULL for global
  name         TEXT NOT NULL,            -- unique per (scope, app_id)
  ciphertext   TEXT NOT NULL,            -- dev: iv:tag:ct ; prod: kv reference
  injection    JSONB NOT NULL,           -- InjectionRecipe
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMP DEFAULT now(),
  rotated_at   TIMESTAMP,
  last_used_at TIMESTAMP
);
CREATE TABLE app_secret_grants (         -- global secrets only
  secret_id UUID NOT NULL REFERENCES app_secrets(id) ON DELETE CASCADE,
  app_id    UUID NOT NULL,
  granted_by TEXT NOT NULL,
  PRIMARY KEY (secret_id, app_id)
);
```

## 4. The injection path: who is allowed to see plaintext

This is §1 made operational, and it's the only genuinely new piece of plumbing.

- **The policy edge (`helix_edge`) never reads `ciphertext`.** It is *not* granted SELECT on `app_secrets.ciphertext` (it is granted SELECT on the *metadata* it needs to authorize — see below). The role-split integration test (`role-split.integration.test.ts`) grows a case asserting `helix_edge` cannot read the ciphertext column, the same way it asserts the edge can't enumerate collections.
- **The registry projection carries bindings, not values.** For each app the edge learns, via the existing LISTEN/NOTIFY projection, its set of `(origin → secretId, injectionRecipe)` connections — *enough to know what to inject and whether the app is allowed to*, never the secret itself. A new `connections` field on `RegistryEntry`, parsed fail-closed like `llm`/`data`. So the policy edge can fully resolve "app X may proxy to origin O using connection C" with zero secret access and zero per-request portal calls.
- **A second role, `helix_egress`, holds the plaintext path.** The egress mechanism — the component that actually makes the outbound call — runs `SecretStore.resolve(secretId)` under `helix_egress`, which *does* have SELECT on `app_secrets.ciphertext` and access to the KEK (dev) / Key Vault read (prod), and **nothing else** — no sessions, no registry write, no gateway_calls. It receives from the policy edge an attested `(app, user, capability, secretId, request-id)` instruction (the signed internal identity header of custom-backends §4/§6.2, minted with the same `jose` the handoff token uses), resolves the one secret named, injects it, makes the call, and returns the stream. It never re-authenticates the user and never sees more than the one secret it was told to spend.

The honest caveat (house rule: name the tension): in **v1 the egress mechanism runs in-edge** (fetch-proxy §6 rung 1, the `EgressProvider` seam), so a single process holds both `helix_edge` and `helix_egress` connections, and an attacker with code execution in that process can reach plaintext. We accept this for v1, bounded by: plaintext is fetched per-call and never persisted; it lives behind one auditable seam; and the architectural endpoint is already written down — architecture §3/§6.1 say the fetch-proxy "may eventually become its own container purely for SSRF egress isolation." When it extracts, `helix_egress` and the secret-holding code leave the policy plane entirely and §1's invariant becomes physical, not just disciplinary. Drawing the **two roles now**, even inside one process, is what makes that extraction a lift-and-shift instead of a re-architecture — and it's the move this codebase's whole ethos (the role split, `role-split.integration.test.ts`) already endorses.

## 5. API surface & the "hook it up" UX

Two route families, split by scope and authority, mirroring the password routes' shape (`apps/portal/src/routes/apps.ts`):

```
# app-scoped secrets — app owner (bearer-gated, like the manifest/password routes)
GET    /api/v1/apps/:slug/secrets                 # metadata list (never values)
POST   /api/v1/apps/:slug/secrets                 # create { name, value, injection }
POST   /api/v1/apps/:slug/secrets/:name/rotate    # set a new value
DELETE /api/v1/apps/:slug/secrets/:name

# global secrets — admin only (requireAdmin, PORTAL_ADMIN_GROUP_ID)
GET    /api/v1/secrets
POST   /api/v1/secrets                             # create { name, value, injection }
POST   /api/v1/secrets/:id/rotate
DELETE /api/v1/secrets/:id
POST   /api/v1/secrets/:id/grants                  # grant to an app  → approval delta (§7)
DELETE /api/v1/secrets/:id/grants/:appId
```

The **portal UI** is a Secrets screen (owner: per-app; admin: a global vault view) plus a binding step on the app's Capabilities/Connections tab. The "hook it up" flow, end to end:

1. Owner creates a secret — pastes the value, names it, picks the injection recipe (default `header-bearer`). The value is encrypted and gone from the UI forever after submit.
2. On the app, the owner adds a **proxy connection**: origin `https://api.stripe.com`, mode `proxy`, connection → the secret just made (or a global secret they've been granted). This is a manifest edit, so it flows through `PUT /manifest`'s write-gate.
3. Because the connection *spends a credential*, the classifier (§7) routes it to approval. On approve, the registry projection gains the `(origin → secretId, recipe)` binding; the app's `fetch('/_api/fetch/https://api.stripe.com/...')` now carries the injected key, server-side, audited — and the app code never changed.

For **global** secrets the binding is two-sided: an admin grants the secret to the app (`POST …/grants`), and the app's manifest references it. Both must be true; either alone is inert. This is the deliberate friction that keeps "global" from meaning "ambient."

## 6. Secrets in the audit ledger

Every lifecycle event — `secret.created`, `secret.rotated`, `secret.deleted`, `secret.granted`, `secret.revoked` — writes to `audit_events`, value never included. Each *use* updates `last_used_at` (written by `helix_egress`) and is already captured by the fetch-proxy's `gateway_calls` row (capability `fetch`, model = target origin), so "which app spent which connection, when, with what outcome" is answerable from the existing Audit page with no new ledger. A stale-secret report ("granted, never used in 90 days") falls out of `last_used_at` for free — the kind of hygiene surface the platform should have.

## 7. Approvals integration

Two distinct actions, two different gates — and the split matters:

- **Storing a secret value is *not* approval-gated.** Creating/rotating/deleting a credential is a privileged write authorized by *who you are* (app owner for app-scoped; `requireAdmin` for global), exactly like setting a password today (`POST …/access/password` is owner-authenticated, not approval-routed). Approving a credential's *bytes* would be theater — the approver can't meaningfully review an opaque key, and the value is write-only anyway.
- **Binding a secret to an app *is* approval-gated**, because that's the act that grants an app the standing capability to spend a credential outbound — precisely the elevated/high-risk shape `classifyChange` (`packages/shared/src/approval.ts`) exists to catch. It rides the existing spine with new delta paths, no new machinery:
  - `capabilities.fetch.origins[+https://api.stripe.com→secret:stripe-live]` — a proxy connection that spends a secret. **Elevated, high risk** (strictly above a keyless `direct` origin grant, which fetch-proxy §4 already noted; an unsecured `proxy` origin is elevated, a secret-bearing one is high).
  - `secret-grant[stripe-live→app:acme-dash]` — granting a *global* secret to an app. **High**, `requireAdmin` to approve, and subject to the same separation-of-duty / `baseSnapshot` conflict-check / idempotency the approval route already enforces (approvals §5). `PORTAL_ALLOW_SELF_APPROVE` remains the refused-in-prod dev escape hatch.

So the spine absorbs secrets with two new classifier cases and zero new tables beyond `app_secrets`/`app_secret_grants`. The `ApprovalRequest` payload (typed `deltas` + `baseSnapshot`) already carries everything; a secret-grant delta is just another row in the bundle.

## 8. Threat mapping

| Threat | Control |
| --- | --- |
| Compromised app reads its own secret | App never receives it; the value reaches plaintext only in `helix_egress` injection, never the browser or projection (§1, §4). |
| Compromised *policy edge* dumps all keys | `helix_edge` has no SELECT on `ciphertext` and no KEK; only `helix_egress` does (§4). Extraction to an egress container makes this physical. |
| Owner UI leaks a key via re-display | No re-display path exists — write-only/rotate-only (§3). The decrypt-for-display code that passwords have is simply absent. |
| Global secret usable by an app that wasn't granted it | Two-sided gate: admin grant row *and* manifest binding both required; either alone is inert (§5). |
| Secret-spend approved without review of intent | Binding is approval-gated, high-risk, `requireAdmin` for global, with separation-of-duty (§7). |
| Stale/over-broad grant lingers | `last_used_at` drives a stale-grant report; revoke is a one-click grant deletion → projection drops the binding (§6). |
| Key-at-rest theft from DB backup | Ciphertext only; KEK is env/Key Vault, not in the DB. Separate KEK from password material (§3). |
| Secret value in logs / audit | Lifecycle events and `gateway_calls` record metadata + outcome, never the value (§6). |

## 9. Milestone fit

v1.x, interleaved with the fetch-proxy rungs (which is its only consumer at first — MCP passthrough and custom backends reuse the same store later):

1. **Secret store + app-scoped CRUD + envelope crypto** (`SecretStore` dev impl, `app_secrets`, write-only routes, Secrets UI). Shippable before any injection exists — it's just a vault. Pairs with fetch-proxy rung 1.
2. **The injection path** — `helix_egress` role, the projection `connections` field, the attested injection instruction, header-bearer injection. This is fetch-proxy **rung 3** (secret-backed connections); the two docs' rung-3 are the same work seen from two sides.
3. **Global secrets + grants + the approval delta cases.** The "shared across apps" half; depends on 1–2 and the approval spine (done).
4. **Key Vault `SecretStore` impl + the egress-container extraction.** Prod hardening; makes §1's invariant physical. Tied to the architecture §3 egress-isolation milestone and the custom-backends §11 "third real app" line.

## 10. Open questions / deliberately deferred

1. **Separate KEK or shared `PORTAL_SECRET`?** Leaning separate (`PORTAL_SECRETS_KEK`) for blast-radius isolation, at the cost of one more piece of key material to manage. Decide before rung 1 — it's a migration boundary.
2. **Injection recipes beyond the three.** OAuth client-credentials (the platform refreshes a token server-side and injects it — stateful, needs a token cache), mTLS client certs, AWS SigV4. v1 ships the static-credential recipes (`header-bearer`/`header`/`query`); the dynamic ones are their own design and defer to fetch-proxy §10 q2.
3. **Two roles in one process, or accept the v1 narrowing without `helix_egress`?** Recommending we draw `helix_egress` now (cheap migration + a second pool, matches the codebase's role-split ethos) — but a leaner v1 could run injection under `helix_edge` with the narrowing documented and defer the role to extraction. Pick deliberately; it sets how honest the §8 row-2 claim is on day one.
4. **Per-secret rotation policy / expiry.** Should the platform nag or force-rotate on an interval, and refuse a connection whose secret is past TTL? Hooks cleanly off `rotated_at`; deferred until there's a real key with a real rotation requirement.
5. **Owner vs. admin boundary on app-scoped secrets.** Is storing an app-scoped secret an owner-only act, or does it also want admin sign-off when the app is `public`? Leaning owner-only (it's their app, their key), but a public app spending a secret on anonymous traffic is exactly the shape that might warrant the approval gate even for app scope. Revisit with the public-tier abuse data.
