# 0006. `SecretStore` custody seam (dev envelope / prod Key Vault)

**Status:** Accepted (amended 2026-07-29 — Key Vault wired)
**Related:** `packages/secret-store`; ADR [0002](0002-postgres-role-split-rls.md), [0013](0013-egress-trust-model.md), [0031](0031-connection-providers-delegated-auth.md)

## Context

Connection secrets (third-party API credentials, the LLM vendor key) must be writable by the control plane, readable only by the mechanism plane, and never readable by the public-facing edge. The storage backend differs between dev (no cloud) and prod (Key Vault).

## Decision

A single `seal` / `open` / `destroy` custody seam, `@azx-pbc/secret-store`, shared by portal (write) and egress (read):

- **dev:** AES-GCM envelope under a post-create-generated KEK. `material` is `aesgcm:<iv>:<tag>:<ciphertext>`, all hex.
- **prod:** Azure Key Vault (`kv-connections`). `material` is `kv:<name>/<version>` — a reference, never ciphertext.

Secrets are managed write-only via the portal (`app_secrets`, app-scoped + admin-global with grants). `helix_edge` has **no grant** on `app_secrets` (ADR [0002](0002-postgres-role-split-rls.md)).

## Consequences

- One interface, two backends; the dev path works without cloud dependencies.
- An edge RCE cannot dump a key — the policy plane has no grant and no decryption seam.
- The plaintext only exists transiently inside egress at injection time.

## Review notes (2026-06-25)

Custody boundary confirmed. The residual exposure is not in custody but in *use*: egress will resolve whatever connection name the edge attests, because the instruction is signature-verified but not authorization-checked — see ADR [0013](0013-egress-trust-model.md).

## Challenge outcome (2026-06-26)

WEAKEN — verified: `open()` returns an unzeroable `string` (plaintext dwell unspecified); **no KEK rotation / rekey** path exists; `destroy()` semantics diverge (dev no-op vs Key Vault delete — documented, worth restating); the prod Key Vault `open()` is currently an unwired stub with **no timeout/retry**, a network failure mode the pure-CPU dev path can't surface. Amend: mark KEK rotation **explicitly deferred**; state plainly that the **dev envelope is not a security boundary** (the ADR is silent, not wrong — don't imply dev ≈ Key Vault); spec a timeout/retry for the prod hot path.

## Amendment (2026-07-29) — Key Vault wired

ADR [0031](0031-connection-providers-delegated-auth.md) §16 made this a hard prerequisite rather than a follow-up: per-user OAuth refresh tokens are *standing access*, stored N users × M providers, and the dev envelope is hygiene. `KeyVaultSecretStore` is now implemented (`packages/secret-store/src/keyvault.ts`), which resolves the four amendments above.

**1. The dev envelope is not a security boundary.** Stated plainly in the code (`src/store.ts`, `src/dev.ts`): the KEK sits on the same host as the database it protects, so anyone who can read the row can read the key. Its job is to keep plaintext credentials out of local dumps and to make the dev and prod call sites identical — not to withstand an attacker. Do not reason about dev custody as if it were Key Vault.

**2. KEK rotation is explicitly deferred.** There is no rotation or rekey path, in either backend. For the dev KEK the recovery is to re-enter the dev secrets, which is acceptable precisely because it is dev. For Key Vault the equivalent question is per-secret rotation, which *is* supported: `seal` mints a new random name and version and `destroy` releases the old, so rotating a credential never mutates an entry in place.

**3. `destroy()` semantics, restated — and now consequential.**

- dev: a genuine no-op. The ciphertext *is* the row and dies with it.
- prod: deletes the vault entry. But `kv-connections` runs `enablePurgeProtection: true` with 90-day soft delete, so this is a **soft** delete — the value stays recoverable for the retention window and cannot be purged early. `destroy()` means "stop serving it and start the retention clock", not "erase". **Crypto-shredding is therefore not achievable through `destroy()` alone**; a GDPR Art. 17 erasure path needs its own design (related: the metering crypto-shred item in `TODO.md`).
- Because names are random (`hx-` + 16 random bytes), a soft-deleted tombstone never blocks a later `seal`.
- A *failed* `destroy` strands a live vault entry still holding the old credential. Callers may no longer swallow it: the portal emits a `secret.destroy_failed` audit event carrying the `kv:` reference (a reference, not a credential — dev ciphertext is never copied into the audit table) so an operator can find and delete the orphan.

**4. Timeout and retry on the prod hot path.** Per-attempt timeout 3 s for `open()`, 10 s for `seal()`/`destroy()`, covering **token acquisition as well as the vault call** — the managed-identity endpoint is a network hop with its own failure modes, and leaving it unbounded would make the deadline below unenforceable however healthy the vault was. A **total deadline** (8 s / 25 s) bounds the whole call so retries can never stack past the egress request budget however slow the vault *or the identity endpoint* is. Retry only on a transport error, `429`, or `5xx`, 2 extra attempts; a `Retry-After` larger than the remaining budget fails immediately rather than sleeping out the budget to no purpose. `403`/`404`/other `4xx` are terminal — an RBAC or integrity failure must fail fast. `KeyVaultError` carries the status so callers can tell a missing vault entry (404, an integrity failure) from an RBAC denial (403), and egress logs both while mapping any resolution throw to an opaque `502`; the untrusted app never sees the vault host or secret name.

The token wait is bounded by **racing**, not by cancelling. `ManagedIdentityTokenProvider` is single-flight — concurrent callers share one promise backed by one HTTP call — so a caller-owned `AbortSignal` would abort that shared fetch and fail every other waiter, precisely under the burst single-flight exists to collapse. Racing lets the refresh finish under its own timeout and still populate the provider's cache, so the next request gets a hit.

**4b. `seal()` writes to the vault before the DB row exists.** Every path from seal to a committed row therefore needs a rollback, or a failure strands a live, unreferenced credential under an opaque random name that nothing can correlate back — and, under purge protection, cannot be removed for 90 days. Two mechanisms: a `release()` rollback on every seal→write path (audited as `secret.destroy_failed` with a `rotate-rollback` / `create-rollback` reason), and a **compare-and-swap** on rotation, because two concurrent rotations otherwise both succeed, both release the *same* original, and leave the loser's new entry orphaned. Losing the CAS is a 409. The admin scopes additionally get a partial unique index (`app_secrets_admin_scope_name_key`), since `appId IS NULL` defeats the model's `@@unique` and the route's pre-check is a non-atomic read-then-insert. **None of this is observable in dev** — the dev `destroy()` is a no-op and `material` is the row — which is exactly the dev/prod divergence this amendment exists to close.

**5. Plaintext dwell — now bounded and stated, not unspecified.** `open()` still returns an unzeroable `string` (unchanged; Node offers no better). What is new is a **version-pinned plaintext cache** inside the store: keyed by the full `kv:<name>/<version>` material, bounded LRU, 5-minute TTL, swept on insert, and dropped on `destroy()` before the vault call — including when a read for that material is already in flight, so a released secret cannot be re-warmed by a race. Because `material` pins an immutable vault version and rotation mints a new name *and* version, a cache hit can never serve a stale value — that is a property of the format, not a hope. The trade is deliberate: without it every secret-backed proxy request becomes a Key Vault round-trip, coupling the whole fetch/LLM path to vault latency and per-vault throttling, which ADR-0031's N users × M providers makes worse. Plaintext already lives in egress by design; the cache bounds *how long*, where before it was per-request but the availability coupling was total.

Be precise about what the TTL bounds: it is how long an entry is **served**, not how long it is *held*. The sweep-on-insert narrows the gap — expired entries no longer linger until a later read of the same material notices them — but a quiet process still retains up to `cacheMax` (512) plaintext values until the next miss. So after an operator revokes a compromised third-party key, egress stops *serving* it immediately but may still *hold* it, and a heap dump or memory-disclosure bug in the mechanism plane would recover it. Dwell as a *policy* (a target, and whether egress should flush on idle) remains open in `TODO.md`.

**Not changed:** the custody boundary itself. `helix_edge` still has no grant on `app_secrets`, no decryption seam, and no vault identity — and `rbac.bicep` deliberately gives the edge identity no role on `kv-connections`. Grant-absence remains the boundary.

**Transport note.** The implementation calls the Key Vault data plane over REST (`api-version=7.4`) rather than taking `@azure/keyvault-secrets`, keeping `@azx-pbc/secret-store` zero-dependency — it is consumed by egress, and ADR-0031 asks that the edge's dependency-minimal reasoning extend to the mechanism plane by degree. The credential is a one-function seam: egress hand-rolls the managed-identity call (mirroring `apps/edge/src/blob/token.ts`), while the portal injects `DefaultAzureCredential`, which it already depends on for Blob (ADR [0027](0027-blob-auth-managed-identity.md)) and which also lets operator scripts run under `az login`.
