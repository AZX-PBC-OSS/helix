# AZX App Platform — Secrets & Connections (design doc)

**Status:** Design draft v1 · June 2026
**Companion to:** `platform-architecture.md` (§3 the `azx-egress` plane, §4.4 "Secrets: Key Vault", §12/M4.5 "secret-backed connections"), `docs/design/fetch-proxy.md` (the consumer — this doc fills in its `connection` field), `docs/design/approvals.md` (the spine secret-grants ride), `docs/platform-custom-backends-and-apis.md` §4 (the policy-plane/mechanism-plane split this leans on), and the password-credential code (`apps/portal/src/access/password.ts`) — the closest existing precedent.
**Why this exists:** The fetch-proxy (and later MCP passthrough, custom backends) needs a place for third-party credentials to live so the app never holds them. "Put it in Key Vault" (architecture §4.4/§12) names the destination and stops there. This doc designs the system of record, the CRUD surface, the app↔secret binding, the approval integration, and — the load-bearing part — **how a secret reaches the outbound call without the edge becoming a place that can read every app's keys.**

> **Related ADRs:** [ADR-0006](../adr/0006-secret-custody-seam.md) (secret custody seam) · [ADR-0005](../adr/0005-ssrf-egress-controls.md) (SSRF + secret injection) · [ADR-0008](../adr/0008-llm-key-via-egress.md) (LLM key via egress) · [ADR-0013](../adr/0013-egress-trust-model.md) (egress trust model).

---

## 1. The one thing that must survive

The password-credential pattern (`access/password.ts`) is the obvious template, and it is *almost* right. The portal mints an xkcd passphrase, encrypts it AES-256-GCM under a key HKDF-derived from `PORTAL_SECRET` (`passwordEnc`, for owner re-display), and projects only the scrypt **hash** + salt to the edge (`apps/edge/src/registry/projection.ts` carries `passwordHash`/`passwordSalt`, never `passwordEnc`). The role split holds for free: `helix_edge` can `SELECT passwordHash` and verify a login, and can *never* recover a password, because a hash is one-way and the edge never sees the ciphertext or the key.

**Connection secrets break that, on purpose, because of what they're for.** Verifying a password needs a one-way digest; injecting a GitHub PAT into `Authorization: Bearer …` needs the **plaintext**. You cannot project a hash and inject it. So the property that made password storage clean — *the edge only ever holds a non-reversible derivative* — cannot hold for a credential the platform has to replay outbound. The invariant therefore shifts from "the edge holds nothing reversible" to:

> **An app never receives a connection secret, and the secret reaches plaintext only inside the egress mechanism that makes the outbound call — never in the browser, never in the registry projection, never in the policy code that resolves identity and authz. The system of record is the control plane; the blast radius of plaintext is one narrow, isolated component — the `azx-egress` service.**

This is the custom-backends §4 **policy-plane / mechanism-plane** split, made concrete for the first time: the edge *policy* plane (session gate, grant evaluation, quota, audit) stays secret-free; the *egress mechanism* (the thing that calls undici outbound and injects the header) is the only code that touches plaintext, and it runs under its own least-privilege identity so a compromise of the policy edge cannot read keys. Everything below serves that line.

## 2. The model: secrets, connections, grants

Three nouns, kept deliberately distinct:

- **Secret** — opaque credential material (a string: an API key, a PAT, a bearer token). Stored encrypted; never returned to anyone after it's set (§4). Has a **scope**: `app` (usable by one app), `global` (usable by many, via grants), or `platform` (a platform-held vendor key — the LLM key — usable by no app's fetch path, resolved by egress only on the `llm` capability; see below). Carries an **injection recipe** — how this credential is applied to a request (`header-bearer` → `Authorization: Bearer {}`; `header` → arbitrary `{name}: {template}`; `query` → `?{param}={}`). The recipe is a property of the *credential*, because how a key is presented is intrinsic to that key, not to the app using it.
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
export const SecretScopeSchema = z.enum(['app', 'global', 'platform']);
// The manifest side (fetch-proxy §4/§5 — `connection` names a secret by name):
//   capabilities.fetch.origins: [{ origin: 'https://api.stripe.com', connection: 'stripe-live' }]
```

## 3. Storage & crypto

**Key custody is a property of the `SecretStore` implementation, not a value the app reads from its environment.** The reflex here is "demand a KEK from an env var and AES-GCM the ciphertext into the DB" — the password path (`passwordEnc`). We deliberately *don't* generalize that, for a reason worth stating outright: encryption at rest only buys anything when the **key and the ciphertext have different exposure profiles.** A KEK in a `.env` next to its ciphertext is hand-managed key material that tempts cross-environment reuse (staging's key decrypting prod), punts generation/rotation to ops, and — the part that matters — does little against the breaches that actually happen to a credential store: **backup/snapshot exfiltration, read replicas, read-only SQLi, insider DB read.** In every one of those the attacker gets the ciphertext; the encryption is decorative unless the key isn't in the same place. (Full RCE/env-dump beats any at-rest scheme — but that's the strongest attacker, not the common one; defense-in-depth is about making the common partial compromise fail *differently* from the rare total one.) So the `SecretStore` seam picks a different custody answer per environment, and the password path stays where it is:

- **prod — Key Vault *is* the store; there is no app-held key.** The secret value lives in the vault; the DB row holds only a vault **reference** + metadata (the `app_secrets` row below). The portal reads/writes via **managed identity** — and that is the actual answer to the env-var complaint: an identity bound to the compute resource by the infra layer, with nothing to copy-paste between environments, so cross-env reuse is structurally absent rather than a discipline ops has to maintain. You also get access audit (who unwrapped what, when) and rotation as a vault primitive. Helix already pays this cost for the vendor LLM key, so the marginal ops burden is ~zero. **Wired** as of 2026-07-29 (`packages/secret-store/src/keyvault.ts`), hardened under dual review and verified against a live vault in the deployment 2026-07-30: `material` is `kv:<name>/<version>` — a version-pinned reference under an opaque random name, so vault metadata leaks no app or secret name. Three caveats worth carrying: `destroy()` is a *soft* delete (purge protection + 90-day retention on `kv-connections`); `open()` keeps a 5-minute plaintext cache in egress so the request path isn't coupled to vault latency and throttling — safe to cache precisely because the version is pinned and rotation mints a new one; and **vault-as-store makes the write two-phase**, since `seal()` puts the value in the vault before the DB row referencing it exists. That last one is the cost of this design that the dev envelope simply doesn't have (there, the ciphertext *is* the row), and it is paid with a `release()` rollback on every seal→write path plus a compare-and-swap on rotation (`409` to the loser) so a crash or a concurrent rotate cannot strand a live credential nothing points at. See the ADR-0006 amendment §§4–5 for the full timeout/retry, orphan and dwell reasoning.
- **dev — a local envelope under an auto-generated key, as *hygiene*, not a boundary.** No vault in the dev container, so the local impl AES-256-GCM-encrypts into Postgres — but the key is **generated on first boot if absent and cached outside the environment** (a gitignored file or a `_local_kek` row), so dev/test are automatically distinct and disposable with zero ops ceremony (no `PORTAL_SECRETS_KEK` to set). This earns ~nothing against a threat model (in dev the key and ciphertext share one laptop) — it is explicitly **not a security boundary** — but it's cheap insurance against the mundane footguns: a *real* key pasted into dev to test against a live API, casual `SELECT *` / screen-share exposure, an accidental commit of a DB dump. Plaintext-in-dev is defensible too **if** we loudly commit to "dev secrets are always fake" — but the envelope enforces that for free, so we take it. There is **no KEK rotation path** — explicitly deferred (ADR-0006).
- **Write-only / rotate-only — *no* re-display, in either environment.** This is where we diverge from passwords, and it's stricter, not looser. A password is re-displayed (`GET …/access/password` decrypts `passwordEnc`) because a *human* has to read it to share it. An API key has no such need — nothing reads it back, so nothing should be *able* to. You set it, rotate it (paste a new value), delete it; you can never read it. That removes the entire "decrypt-for-display" code path and its attack surface. The owner UI shows metadata only: name, scope, injection kind, `createdBy`, `rotatedAt`, `lastUsedAt`, and which apps are bound.

**Scope note — the password path is explicitly *not* migrated by this.** `passwordEnc` is a different shape: it projects a scrypt **hash** to the edge for login verification (which Key Vault can't produce) *and* keeps decryptable ciphertext for deliberate owner re-display (the opposite of write-only). It's also shipped and on the security-critical path. `SecretStore` owns the new write-only connection secrets; the password credential stays as-is. (Whether `passwordEnc` should later move into the vault is its own question, not this doc's.)

```sql
-- portal-owned migration
CREATE TABLE app_secrets (
  id           UUID PRIMARY KEY,
  scope        TEXT NOT NULL,            -- 'app' | 'global' | 'platform'
  app_id       UUID,                     -- NULL for global + platform
  name         TEXT NOT NULL,            -- unique per (scope, app_id)
  material     TEXT NOT NULL,            -- dev: aesgcm:iv:tag:ciphertext ; prod: kv:<name>/<version> — a reference, never plaintext
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

- **The policy edge (`helix_edge`) never touches `app_secrets` at all — no new grants.** It authorizes purely from the manifest binding it already projects (`apps.capabilities`): the approval gate (§7) ensured that binding — origin → connection name — and any global-secret grant were admin-approved before they reached the projection, so at runtime the edge just trusts the projection. It is *not* granted SELECT on `app_secrets` (incl. `material`), and in prod has no Key Vault access. The role-split integration test (`role-split.integration.test.ts`) grows a case asserting `helix_edge` cannot read `app_secrets.material`, the same way it asserts the edge can't enumerate collections.
- **The registry projection carries the binding, not the value or even the secret id.** For each app the edge learns, via the existing LISTEN/NOTIFY projection, its set of `(origin → connection name, recipe kind)` proxy connections — enough to decide to route the call and to name the connection in the attested instruction, never the secret. A new `proxyConnections` field on `RegistryEntry`, parsed fail-closed like `llm`/`data`.
- **`helix_egress`, in its own service, holds the plaintext path.** The egress mechanism — the separate `azx-egress` service (architecture §3) — verifies the attested instruction, then runs `SecretStore.resolve(...)` under the `helix_egress` role, which *does* have SELECT on `app_secrets` (incl. `material`) + `app_secret_grants` and the local-envelope key (dev) / Key Vault read via managed identity (prod), and **nothing else** — no sessions, no registry, no gateway_calls. It resolves the named connection **gated by the instruction's capability**: a `fetch` call resolves app-scoped (`app_id` matches) or a granted `global` (an `app_secret_grants` row exists — the runtime re-check) and *never* a `platform` secret; an `llm` call resolves only a `platform` secret by name. It then injects the credential, makes the call, streams back, and updates `last_used_at`. The instruction it trusts is `(app, user, capability, origin, connection, request-id)`, the signed internal identity header of custom-backends §4/§6.2, minted by the edge with the same `jose` the handoff token uses. Egress never re-authenticates the user and never sees more than the one connection it was told to spend.

The boundary is **physical from day one.** `azx-egress` is its own deployable container — not the edge running an in-process seam to be extracted later. So a compromise of the public-facing edge cannot reach plaintext: the edge holds no `app_secrets` grant, no decryption key, and no Key Vault identity, and the egress service holds no sessions and terminates no app-user traffic. This is the policy/mechanism split (custom-backends §4) taken at the start rather than deferred — building it in-process first would mean shipping exactly the blast radius the split exists to remove. The §1 invariant is enforced by architecture, not discipline. **One honest limit (ADR-0013):** the attested instruction is signed with a **symmetric secret both planes hold**, so the split contains the *read* (a compromised edge never sees plaintext — no `app_secrets` grant, no decryption key, no Key Vault identity) but does **not** contain a *steer* — a compromised edge can forge an instruction for any `appId` and make egress spend a connection, then read the upstream response; there is no `jti` replay-burn or `aud` check, and `method`/`path` are unbound today. Hardening is tracked: jti/aud burn now (#3), per-action authz + method/path binding before multi-tenant (#6), Ed25519 asymmetric signing post-M5.

**The `platform` scope — the LLM vendor key.** The LLM gateway (`llm-gateway.md`) predates this machinery and once held the Anthropic key in edge process memory. It now rides the same path: the vendor key is a `platform`-scoped secret (`app_id` NULL, admin-managed in the portal Secrets page), and the LLM call routes through egress exactly like a fetch — the edge keeps the policy (model allowlist, USD budget, metering, SSE relay) and mints an `llm` instruction; egress injects `x-api-key` and streams the SSE back. Two properties make `platform` safe to resolve without a per-app grant: (1) egress resolves it **only** for the `llm` capability, so an app's `fetch` binding can never name it; and (2) the edge sets the connection name from config (`EDGE_LLM_ANTHROPIC_CONNECTION`), not from the app's manifest, and only after authorizing the call. A `platform` secret is therefore not grantable and not manifest-bindable — the portal grant route is `global`-only, so a `platform` id 404s there. The §1 invariant now holds with no exception: the edge no longer holds even the vendor key. (A direct in-edge provider remains as an **ungated, fail-open dev fallback** selected when egress is unconfigured — slated to be removed from runtime selection and made fail-closed; issue #10, ADR-0008.)

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
  - The proxy-connection binding is implemented as exactly this classifier case (Phase 1): `PUT /manifest` routes it through the write-gate, baseline-vs-elevated splits it, and a secret-bound origin lands as a high-risk pending request.

**Granting a *global* secret to an app** (`POST /api/v1/secrets/:id/grants`) is, in the shipped v1, an **admin-direct** action (`requireAdmin`), not yet a queued `ApprovalRequest`. The net protection is still two independent admin acts: the admin grants the secret *and* approves the manifest binding that spends it. Routing the grant itself through the approval spine as a `secret-grant[…→app:…]` delta — for separation-of-duty between the granting admin and the approving admin — is a deliberate follow-up (it needs a non-capabilities delta type the spine doesn't model yet); see §10.

So the spine absorbs the *binding* with one new classifier case and zero new tables beyond `app_secrets`/`app_secret_grants`; the grant is a direct admin write for now.

## 8. Threat mapping

| Threat | Control |
| --- | --- |
| Compromised app reads its own secret | App never receives it; the value reaches plaintext only in `helix_egress` injection, never the browser or projection (§1, §4). |
| Compromised *policy edge* dumps all keys | `helix_edge` has no SELECT on `material`, no local-envelope key, and no Key Vault access; only `helix_egress`, in its own `azx-egress` container, resolves plaintext (§4). Physical from day one, not disciplinary. |
| Owner UI leaks a key via re-display | No re-display path exists — write-only/rotate-only (§3). The decrypt-for-display code that passwords have is simply absent. |
| Global secret usable by an app that wasn't granted it | Two-sided gate: admin grant row *and* manifest binding both required; either alone is inert (§5). |
| Secret-spend approved without review of intent | Binding is approval-gated, high-risk, `requireAdmin` for global, with separation-of-duty (§7). |
| Stale/over-broad grant lingers | `last_used_at` drives a stale-grant report; revoke is a one-click grant deletion → projection drops the binding (§6). |
| Key-at-rest theft from DB backup / replica / read-only SQLi / insider | Prod: the DB holds only Key Vault references, no value — the backup is inert without vault + managed identity. Dev: ciphertext under a key cached outside the DB. Either way the key and the ciphertext have different exposure profiles, which is the whole point (§3). |
| Secret value in logs / audit | Lifecycle events and `gateway_calls` record metadata + outcome, never the value (§6). |

## 9. Milestone fit

Milestone **M4.5**, interleaved with the fetch-proxy rungs (its only consumer at first — MCP passthrough and custom backends reuse the same store later). The `azx-egress` service is stood up as its own container in the same milestone (fetch-proxy rung 1), so the injection path lands on a boundary that is already physical:

1. **Secret store + app-scoped CRUD + envelope crypto** (`SecretStore` dev impl in `packages/secret-store`, `app_secrets`, write-only routes, Secrets UI). Shippable before any injection exists — it's just a vault. Pairs with fetch-proxy rung 1.
2. **The injection path** — the `helix_egress` role + SELECT-on-`material` grant, the projection `proxyConnections` field, the attested instruction verified in `azx-egress`, header-bearer injection. This is fetch-proxy **rung 3** (secret-backed connections); the two docs' rung-3 are the same work seen from two sides.
3. **Global secrets + grants + the approval delta cases.** The "shared across apps" half; depends on 1–2 and the approval spine (done).
4. **Key Vault `SecretStore` impl (the prod store).** ✅ The vault-as-store custody of §3, swapped in behind the seam with no caller changes — the call sites at `apps/portal/src/routes/secrets.ts` and `apps/egress/src/secrets.ts` were untouched, which is the seam paying for itself. Tied to the M5 Azure milestone and the custom-backends §11 "third real app" line. (The egress *container* itself is not deferred here — it ships in rung 1.)

## 10. Open questions / deliberately deferred

1. **Prod custody: vault-as-store now, or KEK-wrap at scale?** The recommendation is **vault-as-store** — Key Vault holds the value, the DB holds a reference, no app-held key (§3). At Helix's "tens of apps" scale the one-vault-entry-per-secret and per-cold-resolve round-trip are non-issues. *If* volume ever made per-secret vault calls painful, the graduation (not a rewrite — a second `SecretStore` impl) is **KEK-wrap**: Key Vault holds one root KEK fetched via managed identity, per-secret ciphertext lives in the DB, decryption happens at memory speed. Still no env var, still per-environment by identity. This is the real shape of the old "which KEK env var" question — a custody/lifecycle axis, decided per impl behind the seam, not a config knob to pin now.
2. **Injection recipes beyond the three.** OAuth client-credentials (the platform refreshes a token server-side and injects it — stateful, needs a token cache), mTLS client certs, AWS SigV4. v1 ships the static-credential recipes (`header-bearer`/`header`/`query`); the dynamic ones are their own design and defer to fetch-proxy §10 q2.
3. **~~Two roles in one process?~~ Resolved — `azx-egress` is its own service from day one.** Earlier drafts weighed running injection in-edge under a `helix_egress` role and extracting later. Decided against: the egress mechanism ships as its own container in M4.5 (architecture §3), so the §8 row-2 claim ("compromised policy edge dumps all keys → cannot, no grant/key/identity") is true by architecture, not discipline, from the first deploy. The cost of building in-process first was shipping precisely the blast radius the split removes.
4. **Per-secret rotation policy / expiry.** Should the platform nag or force-rotate on an interval, and refuse a connection whose secret is past TTL? Hooks cleanly off `rotated_at`; deferred until there's a real key with a real rotation requirement.
5. **Owner vs. admin boundary on app-scoped secrets.** Is storing an app-scoped secret an owner-only act, or does it also want admin sign-off when the app is `public`? Leaning owner-only (it's their app, their key), but a public app spending a secret on anonymous traffic is exactly the shape that might warrant the approval gate even for app scope. Revisit with the public-tier abuse data.
6. **Global-secret grant through the approval queue.** Shipped v1 makes the grant an admin-direct write (§7); the binding that spends it is still approval-gated, so two admin acts are required either way. Routing the grant itself as a queued `secret-grant` `ApprovalRequest` (separation-of-duty between granting and approving admins) needs a non-capabilities delta type the spine doesn't model yet — deferred.
