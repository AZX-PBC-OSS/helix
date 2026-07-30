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

## Versioning model (git semantics, without git)

The model is essentially **git's, implemented in Postgres + Blob** — and deliberately **not** git:

- **`Version` is an immutable snapshot** (`apps/portal/prisma/schema.prisma` — `model Version`): `appId`, a sequential per-app `number` (`@@unique([appId, number])`), an immutable `blobPrefix` (`apps/<appId>/<n>/`), a `status` (`preview` / `archived`), `createdAt`. A deploy **creates a new row** — never overwrites one; immutability is enforced at the storage layer too (`createOnly` / `If-None-Match: *` on the Blob write).
- **`App.currentVersionId` is the live pointer** (nullable; null before the first promote) — the moving `HEAD`. Exactly one version per app is live, by being pointed at.
- **The verbs map to git:** `helix deploy` = commit a new immutable `preview` version (not yet live); `helix promote` (`routes/versions.ts`) = move `HEAD` to it (atomic pointer flip; idempotent; archived versions must be rolled back, not re-promoted); `helix rollback` = move `HEAD` back to a prior `number`. So **versions ≈ commits, `currentVersionId` ≈ HEAD, `preview`/live/`archived` ≈ branch/tag state**. Every flip is audited (`auditEvent: version.promote`); the edge picks it up sub-second via its registry projection (ADR [0017](0017-registry-listen-notify-projection.md)).

**No git in the serving or deploy path today.** The platform holds no git library and never clones or builds an app's repository (verified: no git shell-out/lib in `apps/` or `packages/`; the dev repo's own git is unrelated). Apps arrive by **CLI zip-upload**, not `git push`. Actual git integration — connect a repo, platform clones + builds + lands a preview — is the **deferred v2 "git-connect"** capability, designed in `docs/design/git-connections.md` and gated by ADR [0026](0026-hosted-build-isolation-prerequisites.md). Keeping git out of the server path is *why* the platform never executes app code/deps today (ADR [0020](0020-static-only-apps-v1.md)).
