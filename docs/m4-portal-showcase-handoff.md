# Handoff: showcasing the M4 LLM gateway in the portal

**Audience:** whoever wires the portal SPA (`apps/portal-web`) + portal API
(`apps/portal`) to surface the M4 gateway that just landed.
**Status of the backend:** committed to `main` (commits `220fded`, `755e725`,
`01b3742`, `be7975d`). The data plane works end to end — see “What already
exists” below.

---

## TL;DR

The M4 gateway is live in the **edge** and the **portal owns the data** for it,
but the **portal API exposes almost none of it for display**, and the SPA still
renders the relevant screens from **mock data behind `PreviewBadge`**. The good
news: the screens are already designed and built. The work is:

1. **Capabilities tab → real manifest.** The read+write API already exists
   (`GET`/`PUT /api/v1/apps/:slug/manifest`). Pure frontend wiring. _(Smallest,
   highest-value — do this first.)_
2. **Usage tab → real metering.** Needs one new portal read endpoint over
   `gateway_calls`, then frontend wiring.
3. **Admin audit log → real `gateway_calls`.** Needs one new portal read
   endpoint, then frontend wiring.
4. **Platform aggregates (`/usage`, admin Platform page).** Optional, larger —
   cross-app rollups.
5. **The live demo.** Deploy the `chatbot` example and watch the Usage tab fill
   in as you chat.

Everything except #4/#5 is "swap mock for real" — the UI exists.

---

## What already exists (don't rebuild it)

### Backend (committed)

- **Manifest storage** — `App.capabilities` JSON column
  (`apps/portal/prisma/schema.prisma`), settable at create and via:
  - `GET  /api/v1/apps/:slug/manifest` → `AppManifest` (open read)
  - `PUT  /api/v1/apps/:slug/manifest` → `AppManifest` (bearer-gated)
  - mapper `toManifest()` / `capabilitiesFromRow()` in
    `apps/portal/src/db/mappers.ts`.
- **`gateway_calls` ledger** — `apps/portal/prisma/schema.prisma`
  (`model GatewayCall`): `appId, userOid, capability, model, inputTokens,
  outputTokens, outcome, createdAt`, indexed `(appId, createdAt)`. **The edge
  writes it** (`apps/edge/src/gateway/usage.ts`); the portal owns the schema and
  may read it freely.
- **The gateway itself** — `POST /_api/llm/chat` on the edge (out of scope here,
  but it's what produces the rows you'll display).
- **Shared contract** — `@helix/shared` exports `AppManifestSchema`,
  `CapabilitiesSchema`, `LlmCapabilitySchema`, `SetManifestRequestSchema`, and
  the LLM wire types.

### Frontend (mock, behind `PreviewBadge` — these are your targets)

| Screen | File | Currently |
|---|---|---|
| Capabilities tab | `apps/portal-web/src/pages/tabs/CapabilitiesTab.tsx` | `PREVIEW_CAPS` mock; "Save manifest (M4)" button **disabled** |
| Usage tab | `apps/portal-web/src/pages/tabs/UsageTab.tsx` | `previewUsageFor(slug)` deterministic mock |
| Admin audit log | `apps/portal-web/src/pages/admin/AuditPage.tsx` | `PREVIEW_AUDIT` mock |
| Admin approvals | `apps/portal-web/src/pages/admin/ApprovalsPage.tsx` | `PREVIEW_APPROVALS` mock (**v1** — leave mocked) |
| Admin CSP violations | `apps/portal-web/src/pages/admin/ViolationsPage.tsx` | `PREVIEW_VIOLATIONS` mock (**v1.x** — leave mocked) |
| Platform / `/usage` | `admin/PlatformPage.tsx`, `pages/UsagePage` | `PREVIEW_PLATFORM` mock |

Mock data lives in `apps/portal-web/src/preview/previewData.ts`. The
`PreviewBadge` component is in `apps/portal-web/src/components/primitives.tsx`.

### Data-layer patterns to follow

- Queries: `apps/portal-web/src/api/queries.ts` (`queryOptions`, `fetchJson(schema, path)`).
- Mutations: `apps/portal-web/src/api/mutations.ts` (`useMutation` + `invalidateQueries`).
- Client: `apps/portal-web/src/api/client.ts` — `fetchJson` attaches the bearer
  token and zod-parses the response.
- Dev: `pnpm dev:web` (:5173) proxies `/api` → portal (:3001); same-origin, no CORS.

---

## Work item 1 — Capabilities tab → real manifest

**The API is done.** This is frontend-only.

**Shared:** nothing new — `AppManifestSchema` / `CapabilitiesSchema` /
`SetManifestRequestSchema` already exist.

**portal-web:**

1. `api/queries.ts` — add:
   ```ts
   export const manifestQuery = (slug: string) =>
     queryOptions({
       queryKey: ["apps", slug, "manifest"],
       queryFn: () =>
         fetchJson(AppManifestSchema, `/api/v1/apps/${encodeURIComponent(slug)}/manifest`),
     });
   ```
2. `api/mutations.ts` — add `useSetManifest()`:
   ```ts
   export function useSetManifest() {
     const qc = useQueryClient();
     return useMutation({
       mutationFn: ({ slug, capabilities }: { slug: string; capabilities: Capabilities }) =>
         fetchJson(AppManifestSchema, `/api/v1/apps/${encodeURIComponent(slug)}/manifest`, {
           method: "PUT",
           body: { capabilities },
         }),
       onSuccess: (_m, { slug }) =>
         void qc.invalidateQueries({ queryKey: ["apps", slug, "manifest"] }),
     });
   }
   ```
3. `pages/tabs/CapabilitiesTab.tsx` — replace `PREVIEW_CAPS` with
   `useQuery(manifestQuery(app.slug))`, enable the editor, and wire the Save
   button to `useSetManifest`. Drop the `PreviewBadge` from the parts now backed
   by real data.

**⚠️ Shape mismatches to fix** (the mock diverged from the real schema):

| Mock (`PREVIEW_CAPS`) | Real (`CapabilitiesSchema`) |
|---|---|
| `origins` | `externalOrigins` |
| `llm.tokensPerDay` always present | `tokensPerDay` is **optional** (omit = no cap) |
| `data` always `{appScope,userScope}` | `data` optional; fields default `false` |
| models `["gpt-5", "claude-fable-5"]` | use real grant; default examples should be `claude-opus-4-8` |

The YAML preview in the tab is hand-built — regenerate it from the fetched
manifest (or, nicer, drop the hand-rolled YAML and render the real fields).

**Notes / decisions:**
- **Approvals are v1.** The architecture says above-baseline grants need
  admin approval; that enforcement is v1 backlog item #2 and is **not** built.
  For the showcase, `PUT manifest` applies the change directly. Keep the
  "above 2M needs admin approval" copy as informational, or gate the Save button
  behind a TODO — don't imply an approval flow exists.
- The edge picks up manifest changes via its registry projection
  (LISTEN/NOTIFY + 60 s reconcile), so a saved grant takes effect within
  seconds — nice to mention in the UI ("changes apply at the edge within ~1 min").

---

## Work item 2 — Usage tab → real metering

Needs **one new portal read endpoint** + frontend wiring.

**Shared** (`packages/shared/src/`): add a usage-summary response schema (new
file `usage.ts`, export from `index.ts`):
```ts
export const UsageSummarySchema = z.object({
  appId: z.uuid(),
  windowDays: z.int().positive(),               // e.g. 1 (today) or 7
  requests: z.int().nonnegative(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  errorRate: z.number().min(0).max(1),
  byOutcome: z.record(z.string(), z.int()),     // ok / error / refusal / quota_blocked
  byModel: z.array(z.object({ model: z.string(), tokens: z.int(), requests: z.int() })),
  series: z.array(z.object({ bucket: z.iso.datetime(), tokens: z.int(), requests: z.int() })),
});
```

**Portal** (`apps/portal/src/routes/`): add
`GET /api/v1/apps/:slug/usage?window=1` (read; see auth decision below). Resolve
the app by slug, then aggregate `gateway_calls`. Sketch:
```sql
-- totals (parameterize the day window)
SELECT count(*)                                        AS requests,
       coalesce(sum("inputTokens"),0)                  AS input_tokens,
       coalesce(sum("outputTokens"),0)                 AS output_tokens,
       coalesce(sum(("outcome" <> 'ok')::int),0)::float / greatest(count(*),1) AS error_rate
FROM gateway_calls
WHERE "appId" = $1 AND "createdAt" >= now() - make_interval(days => $2);

-- series: date_trunc('hour', "createdAt") buckets
-- byModel / byOutcome: group bys
```
Add a `toUsageSummary` mapper in `apps/portal/src/db/mappers.ts` and validate
through the schema. (The edge's `PgUsageStore.tokensUsedToday` in
`apps/edge/src/gateway/usage.ts` is a good reference for the column quoting.)

**portal-web:** add `usageQuery(slug)`, wire `UsageTab.tsx` to it, delete the
`previewUsageFor` call. Map: `Requests/day` → `requests`, `Tokens/day` →
`inputTokens+outputTokens`, error rate → `errorRate`, the two bar charts →
`series`, the capability/model breakdown → `byModel`/`byOutcome`.

**⚠️ Cost is not stored.** `gateway_calls` records **tokens, not dollars**. The
mock shows cost. Options, in order of preference:
1. **Show tokens only** for the showcase (simplest, honest).
2. Add a small per-model price map (input/output $/Mtok) in the portal and
   compute cost in the mapper. If you do this, source the numbers and keep the
   map in one place.

Don't fabricate a `cost` column on `gateway_calls` without deciding the pricing
source — that's a real product decision.

---

## Work item 3 — Admin audit log → real `gateway_calls`

Needs **one new portal read endpoint** + frontend wiring.

**Shared:** add `GatewayCallSchema` (row shape) + a paginated list response.

**Portal:** add `GET /api/v1/gateway/audit?app=&outcome=&limit=&before=`
returning recent `gateway_calls` rows newest-first (cursor on `createdAt`/`id`).
The columns map almost 1:1 to the mock `PreviewAuditRow` (`t, app, user, cap,
target(=model), out(=outcome), tok, cost`) — except `app` is an `appId` (join to
`apps` for the slug) and `cost` is unstored (see WI-2 caveat).

**portal-web:** wire `admin/AuditPage.tsx` to the new query, drop `PREVIEW_AUDIT`.

**⚠️ Auth decision (raise with the team):** the portal's reads are currently
**open** (only mutations require a bearer token). The audit log is "who called
what, on whose behalf" — arguably it should require auth, and eventually
admin-only (RBAC is v1). For the showcase, the safe default is **require a
bearer token** on the audit endpoint (and probably the per-app usage endpoint
too), even though per-app RBAC doesn't exist yet. Decide before shipping.

---

## Work item 4 — Platform aggregates (optional, larger)

The `/usage` page and admin `PlatformPage`/`RegistryPage` render
`PREVIEW_PLATFORM` (14-day token/request series, cost-by-app, capability mix).
Backing these means cross-app aggregation endpoints
(`GET /api/v1/gateway/usage` platform-wide). Same `gateway_calls` source, wider
`GROUP BY`. Defer unless the showcase specifically needs the platform view —
WI-1..3 already tell the per-app story end to end.

---

## Work item 5 — The live demo (proves the whole loop)

The `examples/chatbot` app (committed) exercises the gateway for real. To
showcase metering filling in live:

1. Put `EDGE_LLM_ANTHROPIC_KEY=sk-ant-…` in gitignored `apps/edge/.env.local`.
2. `pnpm dev:idp` · `pnpm dev:portal` · `pnpm dev:edge` · `pnpm dev:web`.
3. Deploy chatbot:
   ```bash
   cd examples/chatbot && export AZX_TOKEN="$PORTAL_DEV_TOKEN"
   node --import tsx ../../packages/cli/src/bin.ts create --display-name "Chatbot"
   node --import tsx ../../packages/cli/src/bin.ts deploy --promote
   ```
4. Grant the LLM capability (this is exactly what WI-1's editor will do):
   ```bash
   curl -fsS -X PUT http://localhost:3001/api/v1/apps/chatbot/manifest \
     -H "authorization: Bearer $PORTAL_DEV_TOKEN" -H "content-type: application/json" \
     -d '{"capabilities":{"llm":{"models":["claude-opus-4-8"],"tokensPerDay":200000}}}'
   ```
5. Open `https://chatbot.localtest.me:8080`, sign in (alice), chat → rows land in
   `gateway_calls` → the (newly-wired) Usage tab and audit log show real traffic.

The capability system was smoke-tested this way already: streaming + non-stream
both work, and enforcement (401 no-session, 403 CSRF/disallowed-model, 429
budget) and metering all behaved correctly.

---

## Suggested order & sizing

| # | Item | Backend work | Frontend work | Size |
|---|---|---|---|---|
| 1 | Capabilities → manifest | none (API exists) | query + mutation + tab | **S** |
| 2 | Usage → metering | new endpoint + schema + SQL | query + tab | **M** |
| 3 | Audit → gateway_calls | new endpoint + schema + SQL | query + page | **M** |
| 5 | Live demo | none | none (ops) | **S** |
| 4 | Platform aggregates | new endpoint(s) | 2 pages | **L** (defer) |

Do 1 → 5 (demo on top of 1) → 2 → 3. That order gets a real, demoable manifest
editor fastest, then layers real metering onto it.

---

## Cross-cutting reminders

- **Edge writes, portal reads.** Don't add portal write paths to `gateway_calls`
  — the edge owns inserts (architecture §3/§8). The portal only reads for display.
- **`date_trunc`/budget day boundary** is server-local in `PgUsageStore`; keep
  the portal's usage SQL consistent with it so "today" matches the edge's quota.
- **Index.** `gateway_calls(appId, createdAt)` exists; per-app windowed queries
  are covered. A platform-wide aggregate (WI-4) may want a `(createdAt)` index —
  add it in a migration if you build #4.
- **Validate at the boundary.** New responses go through zod in `@helix/shared`
  and a `to*` mapper in the portal, like `toApp`/`toManifest` — a test asserts
  DB-shape vs contract drift (see `apps/portal/src/db/mappers.test.ts`).
- **Drop `PreviewBadge`** only from the parts that become real. Approvals
  (v1) and CSP violations (v1.x) stay mocked — leave their badges.

## Touch list

- New: `packages/shared/src/usage.ts` (+ index export); portal usage/audit
  routes; portal-web `manifestQuery`/`usageQuery`/`auditQuery` + `useSetManifest`.
- Edit: `CapabilitiesTab.tsx`, `UsageTab.tsx`, `admin/AuditPage.tsx`,
  `api/queries.ts`, `api/mutations.ts`, `db/mappers.ts` (+ test).
- Leave: `previewData.ts` (approvals/violations/platform still use it).
