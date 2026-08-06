# 0020. Static-only hosted apps in v1

**Status:** Accepted _(recorded retroactively 2026-06-26 — coverage audit; founding constraint)_
**Related:** `docs/platform-architecture.md` §2 (goals/non-goals), §3 (decision #1); `docs/design/custom-backends.md`; ADR [0001](0001-three-runtime-split.md), [0014](0014-same-origin-api-gateway.md)

## Context

Hosting untrusted code is the core risk. **Server-side** untrusted code (containers, custom backends) demands per-app sandboxing, runtime isolation, and network egress control for each app — an order of magnitude more containment work than serving an untrusted **static frontend**, whose only powers are what the browser and the platform gateway grant it.

## Decision

v1 hosts **static frontends only**. Apps ship HTML/JS/CSS/wasm bundles; they run **no app-provided server code**. All dynamic capability — LLM, storage, third-party HTTP — flows through the platform's `/_api/*` gateway (ADR-0014). Arbitrary containers / custom backends are out of scope for v1 (a later isolation tier, see `docs/design/custom-backends.md`).

## Consequences

- The per-app attack surface is a static bundle plus the gateway choke point — no per-app container/sandbox to operate.
- The gateway becomes the **only** dynamic surface, so all governance, metering, and policy concentrate there (which is the intended design).
- Apps that genuinely need a server backend are unsupported until the custom-backend isolation ladder is built.
- This is the founding premise the whole blast-radius model rests on; lifting it reopens the server-side-isolation problem the platform was scoped to avoid.
