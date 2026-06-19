import { z } from "zod";
import { AppSchema } from "./app.js";
import { CapabilitiesSchema, type Capabilities, type FetchConnection } from "./manifest.js";
import { AppManifestSchema } from "./manifest.js";
import { type VisibilityMode } from "./visibility.js";

/**
 * Approvals (design doc `docs/design/approvals.md`). The control-plane gate on
 * *writes* to the effective policy the edge already reads. The `apps` row holds
 * only effective state; "requested state" is the set of open ApprovalRequest
 * rows. This module is the policy spine, kept here in `@helix/shared` so the
 * portal (gating) and the SPA (pre-submit "this will need approval" warning)
 * read the identical thresholds and run the identical classifier (§3).
 */

/** Queue sort + per-delta severity. Ordered low < med < high. */
export const RISK_LEVELS = ["low", "med", "high"] as const;
export const RiskSchema = z.enum(RISK_LEVELS);
export type Risk = z.infer<typeof RiskSchema>;

const RISK_ORDER: Record<Risk, number> = { low: 0, med: 1, high: 2 };
export function maxRisk(risks: Risk[]): Risk {
  return risks.reduce<Risk>((acc, r) => (RISK_ORDER[r] > RISK_ORDER[acc] ? r : acc), "low");
}

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
  "withdrawn",
  "needs_changes",
] as const;
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/**
 * A typed, path-keyed change. `path` is the human-facing key (rendered in the
 * diff and the audit trail); for array membership it carries the affected item
 * (`mcp[+pagerduty]`, `externalOrigins[-https://api.foo.com]`). `from`/`to` hold
 * the scalar values for conflict detection and diff render.
 */
export const DeltaSchema = z.object({
  path: z.string(),
  from: z.union([z.string(), z.number(), z.boolean()]).optional(),
  to: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type Delta = z.infer<typeof DeltaSchema>;

/** The stored/served approval request — mirrors the Prisma model (§2). */
export const ApprovalRequestSchema = z.object({
  id: z.string(),
  appId: z.string(),
  /** Joined for the admin queue / banner; not a column. */
  appSlug: z.string().optional(),
  appDisplayName: z.string().optional(),
  status: ApprovalStatusSchema,
  risk: RiskSchema,
  deltas: z.array(DeltaSchema),
  baseSnapshot: z.unknown(),
  requestedBy: z.string(),
  reason: z.string().nullable().optional(),
  decidedBy: z.string().nullable().optional(),
  decisionNote: z.string().nullable().optional(),
  createdAt: z.string(),
  decidedAt: z.string().nullable().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** Response of `PUT /api/v1/apps/:slug/manifest` under the write-gate (§3). */
export const ManifestUpdateResultSchema = z.object({
  manifest: AppManifestSchema,
  applied: z.array(DeltaSchema),
  pending: z.string().nullable(),
});
export type ManifestUpdateResult = z.infer<typeof ManifestUpdateResultSchema>;

/** Response of `POST /api/v1/apps/:slug/visibility` under the write-gate (§3). */
export const VisibilityUpdateResultSchema = z.object({
  app: AppSchema,
  applied: z.array(DeltaSchema),
  pending: z.string().nullable(),
});
export type VisibilityUpdateResult = z.infer<typeof VisibilityUpdateResultSchema>;

/** Body for a reviewer decision (`deny` / `needs_changes` require a note). */
export const ApprovalDecisionRequestSchema = z.object({
  note: z.string().max(2000).optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

// ── Platform policy (the thresholds the classifier reads) ────────────────────
// These are control-plane numbers, deliberately co-located with the classifier
// so portal-gating and SPA-preview never drift (§3).

/** LLM daily token budget at/under which a grant is baseline. */
export const BASELINE_TOKENS = 1_000_000;
/** App-data daily write/byte budgets at/under which a grant is baseline. */
export const BASELINE_WRITES_PER_DAY = 10_000;
export const BASELINE_BYTES_PER_DAY = 50_000_000;
/** Fetch-proxy daily request budget at/under which a grant is baseline. */
export const BASELINE_FETCH_REQUESTS_PER_DAY = 10_000;

/** Models any app may request without approval. Anything else is elevated. */
export const CURATED_LLM_MODELS: readonly string[] = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

/** Low-risk MCP servers any app may request. Empty ⇒ every MCP grant elevates. */
export const CURATED_MCP_ALLOWLIST: readonly string[] = [];

// ── The classifier ───────────────────────────────────────────────────────────

export interface ClassifyResult {
  /** Apply immediately within the PUT txn (as today). */
  baselineDeltas: Delta[];
  /** Bundle into one ApprovalRequest. */
  elevatedDeltas: Delta[];
  /** Max risk across the elevated deltas (queue sort); "low" when none. */
  risk: Risk;
}

/**
 * Budget privilege, ordered least→most permissive:
 *  - no grant at all (`llm`/`data` absent) ⇒ 0 — the edge 403s without the grant.
 *  - grant present, budget unset ⇒ +∞ — the edge only enforces a defined budget
 *    (`llm.ts` / `data-handler.ts`), so an unset cap is unlimited.
 *  - grant present, budget = n ⇒ n.
 * Removing a cap (n → unset) is therefore a privilege increase; adding one
 * (unset → n) is a reduction.
 */
function budgetPrivilege(hasGrant: boolean, v: number | undefined): number {
  if (!hasGrant) return 0;
  return v ?? Number.POSITIVE_INFINITY;
}

function diffArray(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((x) => !b.has(x)),
    removed: before.filter((x) => !a.has(x)),
  };
}

/**
 * Canonical string key for a fetch proxy connection, used in delta paths and
 * diffing: `https://api.foo.com` (keyless) or `https://api.foo.com→secret:name`
 * (secret-bound). A secret-bound origin is strictly more sensitive, so changing
 * the bound secret is a remove+add of distinct keys.
 */
function fetchOriginKey(c: { origin: string; connection?: string }): string {
  return c.connection ? `${c.origin}→secret:${c.connection}` : c.origin;
}
function parseFetchOriginKey(key: string): { origin: string; connection?: string } {
  const i = key.indexOf("→secret:");
  return i === -1
    ? { origin: key }
    : { origin: key.slice(0, i), connection: key.slice(i + "→secret:".length) };
}

/**
 * Split a requested capability change into baseline (apply now) and elevated
 * (becomes a request) deltas. Two invariants (§3): reducing privilege is always
 * baseline; only increases gate. Each delta is classified independently.
 */
export function classifyChange(effective: unknown, requested: unknown): ClassifyResult {
  const eff = CapabilitiesSchema.parse(effective ?? {});
  const req = CapabilitiesSchema.parse(requested ?? {});

  const baseline: Delta[] = [];
  const elevated: Delta[] = [];
  const elevatedRisks: Risk[] = [];

  const push = (delta: Delta, isElevated: boolean, risk: Risk) => {
    if (isElevated) {
      elevated.push(delta);
      elevatedRisks.push(risk);
    } else {
      baseline.push(delta);
    }
  };

  // ── LLM models ──
  const effModels = eff.llm?.models ?? [];
  const reqModels = req.llm?.models ?? [];
  const models = diffArray(effModels, reqModels);
  for (const m of models.added) {
    const isElevated = !CURATED_LLM_MODELS.includes(m);
    push({ path: `llm.models[+${m}]`, to: m }, isElevated, "med");
  }
  for (const m of models.removed) {
    push({ path: `llm.models[-${m}]`, from: m }, false, "low");
  }

  // ── LLM token budget ──
  const effTokens = eff.llm?.tokensPerDay;
  const reqTokens = req.llm?.tokensPerDay;
  if (effTokens !== reqTokens) {
    const reqPriv = budgetPrivilege(req.llm !== undefined, reqTokens);
    const increase = reqPriv > budgetPrivilege(eff.llm !== undefined, effTokens);
    push(
      { path: "llm.tokensPerDay", from: effTokens, to: reqTokens },
      increase && reqPriv > BASELINE_TOKENS,
      "med",
    );
  }

  // ── data: user store ── (scope itself is baseline; only budgets elevate)
  const effUser = eff.data?.user ?? false;
  const reqUser = req.data?.user ?? false;
  if (effUser !== reqUser) {
    push({ path: "data.user", from: effUser, to: reqUser }, false, "low");
  }

  // ── data: scope arrays ── (collections / shared keys are baseline grants)
  for (const [field, before, after] of [
    ["data.collections", eff.data?.collections ?? [], req.data?.collections ?? []],
    ["data.sharedRead", eff.data?.sharedRead ?? [], req.data?.sharedRead ?? []],
    ["data.sharedWrite", eff.data?.sharedWrite ?? [], req.data?.sharedWrite ?? []],
  ] as const) {
    const d = diffArray(before, after);
    for (const item of d.added) push({ path: `${field}[+${item}]`, to: item }, false, "low");
    for (const item of d.removed) push({ path: `${field}[-${item}]`, from: item }, false, "low");
  }

  // ── data: budgets ──
  for (const [field, effVal, reqVal, threshold] of [
    ["data.writesPerDay", eff.data?.writesPerDay, req.data?.writesPerDay, BASELINE_WRITES_PER_DAY],
    ["data.bytesPerDay", eff.data?.bytesPerDay, req.data?.bytesPerDay, BASELINE_BYTES_PER_DAY],
  ] as const) {
    if (effVal !== reqVal) {
      const reqPriv = budgetPrivilege(req.data !== undefined, reqVal);
      const increase = reqPriv > budgetPrivilege(eff.data !== undefined, effVal);
      push({ path: field, from: effVal, to: reqVal }, increase && reqPriv > threshold, "med");
    }
  }

  // ── mcp ──
  const mcp = diffArray(eff.mcp, req.mcp);
  for (const s of mcp.added) {
    const isElevated = !CURATED_MCP_ALLOWLIST.includes(s);
    push({ path: `mcp[+${s}]`, to: s }, isElevated, "high");
  }
  for (const s of mcp.removed) {
    push({ path: `mcp[-${s}]`, from: s }, false, "low");
  }

  // ── externalOrigins ── (any direct-CSP origin added is elevated)
  const origins = diffArray(eff.externalOrigins, req.externalOrigins);
  for (const o of origins.added) push({ path: `externalOrigins[+${o}]`, to: o }, true, "med");
  for (const o of origins.removed) push({ path: `externalOrigins[-${o}]`, from: o }, false, "low");

  // ── fetch.origins ── (proxied origins; keyless = med, secret-bound = high)
  const effFetch = (eff.fetch?.origins ?? []).map(fetchOriginKey);
  const reqFetch = (req.fetch?.origins ?? []).map(fetchOriginKey);
  const fetchOrigins = diffArray(effFetch, reqFetch);
  for (const key of fetchOrigins.added) {
    const bound = key.includes("→secret:");
    push({ path: `fetch.origins[+${key}]`, to: key }, true, bound ? "high" : "med");
  }
  for (const key of fetchOrigins.removed) {
    push({ path: `fetch.origins[-${key}]`, from: key }, false, "low");
  }

  // ── fetch.shim ── (serve-time ergonomics; never a privilege grant)
  const effShim = eff.fetch?.shim ?? false;
  const reqShim = req.fetch?.shim ?? false;
  if (effShim !== reqShim) {
    push({ path: "fetch.shim", from: effShim, to: reqShim }, false, "low");
  }

  // ── fetch.requestsPerDay budget ──
  const effFetchReq = eff.fetch?.requestsPerDay;
  const reqFetchReq = req.fetch?.requestsPerDay;
  if (effFetchReq !== reqFetchReq) {
    const reqPriv = budgetPrivilege(req.fetch !== undefined, reqFetchReq);
    const increase = reqPriv > budgetPrivilege(eff.fetch !== undefined, effFetchReq);
    push(
      { path: "fetch.requestsPerDay", from: effFetchReq, to: reqFetchReq },
      increase && reqPriv > BASELINE_FETCH_REQUESTS_PER_DAY,
      "med",
    );
  }

  return { baselineDeltas: baseline, elevatedDeltas: elevated, risk: maxRisk(elevatedRisks) };
}

export interface VisibilityChange {
  delta: Delta;
  elevated: boolean;
  risk: Risk;
}

/**
 * Visibility lives in flat `apps` columns, not in `capabilities`, so it is
 * classified on its own. Only `→ public` elevates (high); every other move,
 * including `public → private`, is a baseline privilege reduction (§3).
 */
export function classifyVisibilityChange(
  from: VisibilityMode,
  to: VisibilityMode,
): VisibilityChange | null {
  if (from === to) return null;
  const elevated = to === "public";
  return { delta: { path: "visibility", from, to }, elevated, risk: elevated ? "high" : "low" };
}

// ── Applying deltas (route baseline write + approve elevated write) ───────────

const ARRAY_PATH = /^(.*)\[([+-])(.*)\]$/;

/**
 * Apply capability deltas to a capabilities object, returning a fresh parsed
 * copy. Visibility deltas are ignored here (the caller applies those to the
 * flat columns). Used to compute the baseline-applied capabilities on a PUT and
 * to apply the elevated bundle on approve.
 */
export function applyDeltas(capabilities: unknown, deltas: Delta[]): Capabilities {
  const next = CapabilitiesSchema.parse(JSON.parse(JSON.stringify(capabilities ?? {})) as unknown);

  for (const d of deltas) {
    const m = ARRAY_PATH.exec(d.path);
    if (m) {
      const [, field, op, item] = m as unknown as [string, string, "+" | "-", string];
      applyArray(next, field, op, item);
      continue;
    }
    applyScalar(next, d);
  }

  return CapabilitiesSchema.parse(next);
}

function applyArray(caps: Capabilities, field: string, op: "+" | "-", item: string): void {
  const add = (arr: string[]) =>
    op === "+" ? (arr.includes(item) ? arr : [...arr, item]) : arr.filter((x) => x !== item);
  switch (field) {
    case "mcp":
      caps.mcp = add(caps.mcp);
      return;
    case "externalOrigins":
      caps.externalOrigins = add(caps.externalOrigins);
      return;
    case "llm.models":
      caps.llm = { ...(caps.llm ?? { models: [] }), models: add(caps.llm?.models ?? []) };
      return;
    case "data.collections":
    case "data.sharedRead":
    case "data.sharedWrite": {
      const data = caps.data ?? { user: false, collections: [], sharedRead: [], sharedWrite: [] };
      const key = field.slice("data.".length) as "collections" | "sharedRead" | "sharedWrite";
      caps.data = { ...data, [key]: add(data[key]) };
      return;
    }
    case "fetch.origins": {
      const fetch = ensureFetch(caps);
      const has = (o: FetchConnection) => fetchOriginKey(o) === item;
      const origins =
        op === "+"
          ? fetch.origins.some(has)
            ? fetch.origins
            : [...fetch.origins, parseFetchOriginKey(item)]
          : fetch.origins.filter((o) => !has(o));
      caps.fetch = { ...fetch, origins };
      return;
    }
    default:
      return;
  }
}

function applyScalar(caps: Capabilities, d: Delta): void {
  switch (d.path) {
    case "llm.tokensPerDay":
      caps.llm = { ...(caps.llm ?? { models: [] }), tokensPerDay: d.to as number | undefined };
      return;
    case "data.user":
      caps.data = { ...ensureData(caps), user: Boolean(d.to) };
      return;
    case "data.writesPerDay":
      caps.data = { ...ensureData(caps), writesPerDay: d.to as number | undefined };
      return;
    case "data.bytesPerDay":
      caps.data = { ...ensureData(caps), bytesPerDay: d.to as number | undefined };
      return;
    case "fetch.shim":
      caps.fetch = { ...ensureFetch(caps), shim: Boolean(d.to) };
      return;
    case "fetch.requestsPerDay":
      caps.fetch = { ...ensureFetch(caps), requestsPerDay: d.to as number | undefined };
      return;
    default:
      return;
  }
}

function ensureData(caps: Capabilities) {
  return caps.data ?? { user: false, collections: [], sharedRead: [], sharedWrite: [] };
}

function ensureFetch(caps: Capabilities) {
  return caps.fetch ?? { shim: false, origins: [] };
}

// ── Conflict detection (optimistic concurrency, §5) ──────────────────────────

const AREAS = ["llm", "data", "mcp", "externalOrigins", "fetch", "visibility"] as const;
type Area = (typeof AREAS)[number];

function deltaArea(path: string): Area {
  if (path === "visibility") return "visibility";
  if (path.startsWith("llm")) return "llm";
  if (path.startsWith("data")) return "data";
  if (path.startsWith("mcp")) return "mcp";
  if (path.startsWith("fetch")) return "fetch";
  return "externalOrigins";
}

/** The distinct policy areas a set of deltas touches. */
export function touchedAreas(deltas: Delta[]): Area[] {
  const set = new Set<Area>();
  for (const d of deltas) set.add(deltaArea(d.path));
  return AREAS.filter((a) => set.has(a));
}

/**
 * Snapshot the effective value of each touched area at request time. Stored as
 * `baseSnapshot`; compared at approve time to detect a value that moved
 * underneath the open request (a baseline write or another approval).
 */
export function captureSnapshot(
  effective: unknown,
  visibilityMode: VisibilityMode,
  areas: Area[],
): Record<string, unknown> {
  const caps = CapabilitiesSchema.parse(effective ?? {});
  const snap: Record<string, unknown> = {};
  for (const area of areas) {
    snap[area] =
      area === "visibility" ? visibilityMode : (caps[area as keyof Capabilities] ?? null);
  }
  return snap;
}

/**
 * True if any snapshotted area no longer matches current effective state — the
 * diff is stale and approval must bounce to `needs_changes` rather than clobber.
 * Array reordering counts as a change (conservative, safe direction).
 */
export function snapshotConflicts(
  baseSnapshot: unknown,
  effective: unknown,
  visibilityMode: VisibilityMode,
): boolean {
  if (baseSnapshot === null || typeof baseSnapshot !== "object") return false;
  const snap = baseSnapshot as Record<string, unknown>;
  const current = captureSnapshot(effective, visibilityMode, Object.keys(snap) as Area[]);
  for (const key of Object.keys(snap)) {
    if (JSON.stringify(snap[key]) !== JSON.stringify(current[key])) return true;
  }
  return false;
}
