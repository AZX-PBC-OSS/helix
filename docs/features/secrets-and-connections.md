# Connection secrets

**What it is.** Third-party credentials the platform holds so a hosted app never
does (architecture §6.1, §12; design `docs/design/secrets-and-connections.md`).
A secret is stored sealed, referenced by name from a proxied origin
(`capabilities.fetch.origins[].connection`), and injected server-side by
`azx-egress` on the outbound hop — so an API key reaches the third party without
ever reaching the browser, the edge, or the registry projection.

**Handler.** Portal CRUD: `apps/portal/src/routes/secrets.ts`. Custody seam:
`packages/secret-store` (`@helix/secret-store`). Resolution: `apps/egress`.

| Route | Who | What |
| --- | --- | --- |
| `GET/POST/DELETE /api/v1/apps/:slug/secrets[/:name]`, `…/:name/rotate` | app owner | app-scoped CRUD |
| `GET/POST/DELETE /api/v1/secrets[/:id]`, `…/:id/rotate` | admin | global secret CRUD |
| `POST/DELETE /api/v1/secrets/:id/grants[/:appId]` | admin | grant a global secret to an app |

## How it works

### Two scopes

- **app** — owned by one app (`appId` set); the owner manages it.
- **global** — admin-only, shared across apps via explicit per-app **grants**
  (`app_secret_grants`). "Global" never means "ambiently available": an app must
  both hold a grant *and* reference the secret in its manifest.

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
  env var that tempts cross-environment reuse).
- **prod:** `KeyVaultSecretStore` — the value lives in Key Vault; `material` is
  only a reference; read via managed identity (no app-held key). Wired in M5.

Encryption-at-rest only buys anything when the key and the ciphertext have
*different* exposure profiles — so the key never sits next to the ciphertext.

### The role split (the real boundary)

The portal **seals** (writes); the **`azx-egress`** service is the only reader,
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

## Planned / not yet built

- **Key Vault `SecretStore`** (prod custody) — seam present, wired in M5.
- **Grant via the approval queue** (separation-of-duty between granting and
  approving admins) — design §10.
- **Rotation policy / expiry** off `rotatedAt` — design §10.
