# 0006. `SecretStore` custody seam (dev envelope / prod Key Vault)

**Status:** Accepted
**Related:** `packages/secret-store`; ADR [0002](0002-postgres-role-split-rls.md), [0013](0013-egress-trust-model.md)

## Context

Connection secrets (third-party API credentials, the LLM vendor key) must be writable by the control plane, readable only by the mechanism plane, and never readable by the public-facing edge. The storage backend differs between dev (no cloud) and prod (Key Vault).

## Decision

A single `seal` / `open` / `destroy` custody seam, `@helix/secret-store`, shared by portal (write) and egress (read):

- **dev:** AES-GCM envelope under a post-create-generated KEK.
- **prod:** Azure Key Vault (wired in M5).

Secrets are managed write-only via the portal (`app_secrets`, app-scoped + admin-global with grants). `helix_edge` has **no grant** on `app_secrets` (ADR [0002](0002-postgres-role-split-rls.md)).

## Consequences

- One interface, two backends; the dev path works without cloud dependencies.
- An edge RCE cannot dump a key — the policy plane has no grant and no decryption seam.
- The plaintext only exists transiently inside egress at injection time.

## Review notes (2026-06-25)

Custody boundary confirmed. The residual exposure is not in custody but in *use*: egress will resolve whatever connection name the edge attests, because the instruction is signature-verified but not authorization-checked — see ADR [0013](0013-egress-trust-model.md).

## Challenge outcome (2026-06-26)

WEAKEN — verified: `open()` returns an unzeroable `string` (plaintext dwell unspecified); **no KEK rotation / rekey** path exists; `destroy()` semantics diverge (dev no-op vs Key Vault delete — documented, worth restating); the prod Key Vault `open()` is currently an unwired stub with **no timeout/retry**, a network failure mode the pure-CPU dev path can't surface. Amend: mark KEK rotation **explicitly deferred**; state plainly that the **dev envelope is not a security boundary** (the ADR is silent, not wrong — don't imply dev ≈ Key Vault); spec a timeout/retry for the prod hot path.
