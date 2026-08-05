# Connection secrets

> **Related ADRs:** [ADR-0006](../adr/0006-secret-custody-seam.md) (secret custody seam) · [ADR-0005](../adr/0005-ssrf-egress-controls.md) (SSRF + secret injection) · [ADR-0002](../adr/0002-postgres-role-split-rls.md) (Postgres role split + RLS) · [ADR-0013](../adr/0013-egress-trust-model.md) (egress trust model).

**What it is.** Third-party credentials the platform holds so a hosted app never
does (architecture §6.1, §12; design `docs/design/secrets-and-connections.md`).
A secret is stored sealed, referenced by name from a proxied origin
(`capabilities.fetch.origins[].connection`), and injected server-side by
`helix-egress` on the outbound hop — so an API key reaches the third party without
ever reaching the browser, the edge, or the registry projection.

| Route | Who | What |
| --- | --- | --- |
| `GET/POST/DELETE /api/v1/apps/:slug/secrets[/:name]`, `…/:name/rotate` | app owner | app-scoped CRUD |
| `GET/POST/DELETE /api/v1/secrets[/:id]`, `…/:id/rotate` | admin | global secret CRUD |
| `POST/DELETE /api/v1/secrets/:id/grants[/:appSlug]` | admin | grant a global secret to an app (by slug) |

## How it works

### Two scopes

- **app** — owned by one app (`appId` set); the owner manages it.
- **global** — admin-only, shared across apps via explicit per-app **grants**
  (`app_secret_grants`). "Global" never means "ambiently available": an app must
  both hold a grant *and* reference the secret in its manifest.

A secret is the unit, and **one secret can back many connections** (it is not a
bundle-per-app): it's the only model where "rotate the Stripe key once, all six
apps follow" holds.

### Injection recipes

A secret carries an `InjectionRecipe` chosen at create time, applied by egress on
the outbound hop (`packages/shared/src/secrets.ts`):

- `header-bearer` — `Authorization: Bearer <value>` (the default).
- `header` — an arbitrary header from a `{}` template (e.g. `x-api-key: {}`).
- `query` — a query-string parameter (e.g. `?api_key=<value>`).
- `hmac-timestamp` — a **derived** credential for APIs that want a signature
  rather than a static key. Egress reads the clock once per request, writes it to
  `timestampHeader`, and renders `template` into `authHeader` with `{credential}`
  (the public half) and `{signature}` = `hex(HMAC-SHA256(privateKey, timestamp))`.
  The signed input is the timestamp alone — no method, path, or body. SHA-256,
  lowercase hex, and ISO-8601-with-milliseconds are fixed by the kind.

Header names are normalised to lowercase (and trimmed) and must be RFC 7230
tokens; `host`, the framing headers, and the `x-helix-` prefix are refused.
(`host` in particular would move TLS SNI off the allowlisted origin.) For
`hmac-timestamp`, `timestampHeader` and `authHeader` must differ — both are
written into one header set, timestamp first, so equal names make the auth value
overwrite the timestamp and the upstream verifies a signature over a timestamp it
never received.

A `header` template substitutes **every** `{}`, not just the first. A stored
template with two `{}` therefore embeds the credential twice; that changed with
the switch away from `String.replace`, which also stopped a credential containing
`$&` being silently mangled into an unexplainable auth failure.

### Reading a stored recipe

`app_secrets.injection` is schemaless JSON that both the portal and egress
re-parse on **every read**, so writes are validated strictly and reads leniently.
The line is drawn at who a violation hurts:

- *Hygiene* (the token charset, the length caps, the ASCII-only template) is
  **request-only**. A stored row that violates one was already dead on the wire —
  undici rejects it when constructing the request — so enforcing it on read would
  convert a contained per-call 502 into an unreadable secret.
- *Security* (the reserved names above) fails closed on **both** sides.

A secret badged **"recipe unreadable"** has a stored recipe that trips a security
rule. It still exists, still holds its credential, and can still be deleted — but
it cannot be rotated (409) and egress fails its hop closed (502). Recipes are
immutable, so the fix is delete-and-recreate. To look for such rows before a
deploy:

```sql
SELECT id, scope, env, name, injection FROM app_secrets
 WHERE injection->>'kind' IN ('header', 'hmac-timestamp');
```

Note rotation replaces the credential, not the recipe — a row with a broken
recipe stays broken on the wire after rotating.

The value for `hmac-timestamp` is a JSON blob holding **both halves** —
`{"credential": "…", "key": "…"}`. The portal validates that shape before sealing,
on create *and* rotate, and refuses a blob stored under a static recipe (which
would present it verbatim and put the private half in the vendor's access log).
Packing both halves is what makes a regenerated key pair rotate atomically through
the ordinary rotate route; the trade is that metadata can never show *which* pair
is installed, only that the recipe is `hmac-timestamp`.

Operationally, because the signature is over `now`, egress clock drift shows up as
the vendor's own 401 passed through. Egress logs a warning when the upstream's
`Date` header disagrees with local time by more than a minute — the only in-band
hint that the cause is the platform rather than the credential.

### Write-only / rotate-only

The value crosses the API boundary **only** on create/rotate. It is sealed by
the `SecretStore` and **never returned** — there is no re-display route (unlike
the shared-password credential, which a human must read to share). The owner UI
shows metadata only (name, injection recipe, `lastUsedAt`, bound apps).

### Custody (the `SecretStore` seam)

One interface (`seal`/`open`/`destroy`); the custody model is chosen per
environment (architecture §8):

- **dev:** `DevEnvelopeSecretStore` — AES-256-GCM into the `app_secrets.material`
  column under a locally-generated KEK (`.devcontainer/post-create.sh`, never an
  env var that tempts cross-environment reuse). This envelope is **hygiene, not a
  security boundary** — the KEK and the ciphertext share one dev machine — and
  there is **no KEK rotation path** (explicitly deferred). (ADR-0006.)
- **prod:** `KeyVaultSecretStore` — the value lives in Key Vault (`kv-connections`);
  `material` is only a reference (`kv:<name>/<version>`); read via managed identity
  (no app-held key). Wired: Key Vault data-plane REST over global `fetch`, so the
  package stays zero-dependency, with the credential injected as a one-function
  seam (egress hand-rolls the managed-identity call, the portal uses
  `DefaultAzureCredential`). `open()` carries an explicit timeout/retry budget and
  a version-pinned plaintext cache; `destroy()` is a *soft* delete under purge
  protection. (ADR-0006 and its 2026-07-29 amendment.)

Which backend is in play is decided in one place — `apps/portal/src/secrets/custody.ts`
for the portal, `apps/egress/src/config.ts` for egress — off two env vars:
`AZURE_KEY_VAULT_URL` (Key Vault, wins if both are set) and `DEV_SECRETS_KEK_FILE`
(the dev envelope). Neither configured means no store; **configured-but-broken
throws** — a missing KEK or an unusable credential is never a fallback to a weaker
seal. The vault URL must be `https:`. Material is scheme-checked on read, so an
environment sealed under the dev envelope and then pointed at a vault fails every
secret at once with a named scheme rather than a vague "malformed"; egress also
warns at boot with a count of cross-scheme rows.

**Live-vault status.** Verified in the deployment against a real Key Vault
(2026-07-30) — the portal seals and egress opens through the vault under the real
managed identities, not just against the test fakes. The local suite (unit +
cross-seam integration against injected transports) proves `material` portability
but deliberately cannot prove identity separation: both stores there share one stub
`getToken` and the fake vault ignores the authorization header. See `TODO.md` for
the one assertion that still wants a live check — that the **edge** identity is
refused by `kv-connections`, which is grant-*absence* and so fails open in every
test that doesn't look for it.

### Orphan safety on write (prod-only, invisible in dev)

`seal()` writes the value to the vault **before** the DB row exists, so any failure
between the two strands a live, unreferenced credential under a deliberately opaque
random name — with no audit trail and, under purge protection, unremovable for 90
days. Three mechanisms close it, and none of them is observable in dev, where
`destroy()` is a no-op and `material` *is* the row:

- **Rollback on every seal→write path.** A failed create or rotate releases the
  entry it just minted, audited as `secret.destroy_failed` with a
  `create-rollback` / `rotate-rollback` reason (the `kv:` reference is recorded —
  a reference, not a credential; dev ciphertext is never copied into the audit
  table). A *failed* rollback is likewise audited so an operator can find the
  orphan.
- **Compare-and-swap on rotate → `409`.** Two concurrent rotations both succeed
  under a plain update, both release the *same* original, and strand the loser's
  fresh entry. Losing the CAS is now a `409`, not a silent `200` — the API is
  telling the caller their value is **not** what is stored, and the rotation should
  be retried.
- **A partial unique index on the admin scopes** (`app_secrets_admin_scope_name_key`),
  because `appId IS NULL` defeats the model's `@@unique` and the route's pre-check
  is a non-atomic read-then-insert.

Encryption-at-rest only buys anything when the key and the ciphertext have
*different* exposure profiles — so the key never sits next to the ciphertext.
The original plan was an env-var KEK; it was **reversed**, because
generate-at-boot-and-store-in-DB puts the key in the same backup as the
ciphertext — decorative against the #1 real at-rest threat (backup/snapshot
exfil). Hence **vault-as-store** in prod (the DB row holds a reference, never an
app-held key) and the column is `material` (a reference or ciphertext), not
`ciphertext`. Helix is "a custodian of N tenants' third-party credentials" — a
breach reads "we disclosed our customers' Stripe keys" ×N; the consequence
asymmetry, not the probability, settles the design. (`passwordEnc` is
deliberately *not* migrated here — it's a different shape: hash-to-edge plus
owner re-display.)

### The role split (the real boundary)

The portal **seals** (writes); the **`helix-egress`** service is the only reader,
under the dedicated `helix_egress` role. That role has `SELECT` on
`app_secrets`/`app_secret_grants` and `UPDATE` on `lastUsedAt` only — and nothing
else. The policy edge (`helix_edge`) has **no grant on `app_secrets` at all**.
A compromise of the public-facing edge therefore cannot read a single
credential: no DB grant, no decryption key, no Key Vault identity. Asserted in
`role-split.integration.test.ts`.

### Approvals

Storing a credential is an authorized-direct write (owner for app-scoped,
`requireAdmin` for global) — approving opaque key bytes would be theatre.
**Binding** a secret to a proxied origin is a manifest change and rides the
approval write-gate (`classifyChange` flags a secret-bound origin as high risk).
Granting a global secret to an app is admin-direct in v1 (design §7/§10).

## Try it

In the portal, **Capabilities → Connection secrets**: add a secret (name + value
+ injection recipe). Then in **Fetch proxy**, bind a proxied origin to it by
name and save (a secret-bound origin opens an admin-approval request). Once
approved, the app's `fetch('/_api/fetch/<origin>/…')` carries the injected
credential — and the value was never in the bundle.

**Global** secrets are managed by admins on the portal's **Secrets** page
(`/admin/secrets`): create, rotate, delete, and grant/revoke to apps by slug.

## Key files

- `apps/portal/src/routes/secrets.ts` — the CRUD + grant routes (seal-on-write).
- `packages/secret-store/src/` — the `SecretStore` seam (`store.ts`), the dev envelope (`dev.ts`), the Key Vault impl (`keyvault.ts`), and the managed-identity token provider (`token.ts`).
- `apps/egress/src/secrets.ts` — `PgSecretResolver`, the only reader (`helix_egress` role).
- `apps/portal/prisma/migrations/…_secrets_and_egress_grants/` — `app_secrets`/`app_secret_grants` + the role grants.

## Planned / not yet built

- **A real erasure path.** `destroy()` under purge protection is a soft delete —
  90-day retention, no early purge — so crypto-shredding needs its own design.
- **Grant via the approval queue** (separation-of-duty between granting and
  approving admins) — design §10.
- **Rotation policy / expiry** off `rotatedAt` — design §10.
