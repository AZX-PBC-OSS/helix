# 0018. Deploy model: upload-only, immutable versions, preview→live pointer flip

**Status:** Accepted _(recorded retroactively 2026-06-26 — coverage audit; shipped in M1/M2)_
**Related:** `docs/platform-architecture.md` §5, §5.1 (decisions #1, #10); `docs/features/registry-and-deploys.md`; `apps/portal/src/routes/versions.ts`, `apps/portal/src/deploy/pointer.ts`

## Context

Untrusted app bundles need a deploy path that is safe, cheap to roll back, and amenable to agent automation, without a hosted build service in v1.

## Decision

- **Upload-only in v1** — a deploy uploads a prebuilt static bundle (CLI/zip); hosted git-connect / build is deferred (v2).
- Each deploy is an **immutable, versioned Blob bundle** (content-addressed under the app).
- Deploys land as **`preview`**; promotion to **`live`** is a separate **atomic pointer flip** in the registry. **Rollback is the same operation** — flip the live pointer to a prior version.
- Agent/CLI deploys default to **preview**; a human promotes to live (a security guardrail).

## Consequences

- Promote and rollback are symmetric, cheap, and instant; HTML is served `no-cache` so a flip takes effect immediately.
- Preview-by-default contains a bad (or hostile-agent) deploy until a human promotes.
- No build provenance in v1 (the platform trusts the uploaded artifact; containment is per-app, ADR-0001).
- Adding a build service later is additive (it produces the same immutable version artifact); the promotion/rollback model does not change.
