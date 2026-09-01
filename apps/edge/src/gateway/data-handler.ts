import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiErrorCode, Env } from "@azx-pbc/shared";
import type { GatewayConfig } from "../config.js";
import type { RegistryReader } from "../registry/projection.js";
import {
  meterIdentity,
  type Caller,
  type CallerResolver,
  type MeterIdentity,
} from "../auth/gate.js";
import type { RegistryEntry } from "../registry/projection.js";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import type { OriginCheck } from "../auth/validate.js";
import type { AppDataStore, CollectionMeta, WritePrecondition } from "./data.js";
import { anonRateLimited, type IpRateLimiter } from "./ipRateLimiter.js";
import {
  ATTR_APP_SLUG,
  ATTR_CAPABILITY,
  ATTR_DATA_VERB,
  ROUTE_DATA,
  SPAN_DATA,
} from "@azx-pbc/shared/telemetry";
import { withRootSpan } from "../telemetry.js";
import { meterGatewayCall, type UsageStore } from "./usage.js";

/**
 * `/_api/data/*` — the gateway's app-data capability (architecture §6.1,
 * app-data design §3/§5). Every handler reuses the LLM gateway's preamble
 * (`llm.ts`): resolve serving entry → resolve caller (gate, or anon on public
 * apps) → Origin/CSRF check on mutations → capability/scope check → body
 * validation → store call → meter. Reads send `cache-control: no-store`.
 *
 * Writes are compare-and-swap on an opaque `version` (ADR-0041): reads emit it
 * as `ETag: "<version>"`, and a PUT states its assumption with
 * `If-Match: "<version>"` (write if current) or `If-None-Match: *`
 * (create-if-absent). Preconditions are MANDATORY on `shared` — a shared PUT
 * carrying neither is 428 `precondition_required` — and optional on `user`,
 * which keeps last-write-wins by default. A stated precondition that doesn't
 * hold is 412 `conflict`. Neither failure is CHARGED against writesPerDay
 * (decision 7); a 412 still records a non-charging `conflict` ledger row so a
 * contended retry loop is visible rather than silent.
 *
 * The §3.2 collection invariant is structural: there is no list/read verb for
 * collections here, and the store has no method to enumerate them — covered by
 * an adversarial test asserting those paths 404/405.
 */

export interface DataGatewayRuntime {
  config: GatewayConfig;
  registry: RegistryReader;
  resolveCaller: CallerResolver;
  /** CSRF seam (dev-mode §5.4): edge = exact same-origin; dev-gateway = allowlist. */
  checkOrigin: OriginCheck;
  /** Per-IP limiter for the anonymous tier (public apps); null disables it. */
  anonLimiter: IpRateLimiter | null;
  /** Null when the capability isn't configured on this edge — handlers 503. */
  store: AppDataStore | null;
  usage: UsageStore | null;
}

/** Max stored value size — opaque app JSON, size-capped (app-data design §9). */
const MAX_VALUE_BYTES = 64 * 1024;
/** Key constraints: non-empty, bounded, no control chars (it is a path segment). */
const MAX_KEY_LENGTH = 256;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function sendApiError(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): void {
  reply
    .status(status)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send({ error: { code, message, ...(details === undefined ? {} : { details }) } });
}

/**
 * Serialized UTF-8 byte size of a JSON value. `String.length` counts UTF-16 code
 * units, which undercounts multibyte UTF-8 (CJK, emoji) — a value "capped" by
 * length could persist well over the byte cap on disk (issue #12).
 */
function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function validKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    Buffer.byteLength(key, "utf8") <= MAX_KEY_LENGTH &&
    !CONTROL_CHARS.test(key)
  );
}

function keyParam(req: FastifyRequest): string | null {
  const key = (req.params as { key?: string }).key;
  return validKey(key) ? key : null;
}

function nameParam(req: FastifyRequest): string | null {
  const name = (req.params as { name?: string }).name;
  return validKey(name) ? name : null;
}

/**
 * The write's stated concurrency assumption (ADR-0041). `ifMatchAny` is
 * `If-Match: *` — "any current representation" — which states NO assumption and
 * is refused everywhere: on `shared` it is the one-character escape hatch
 * around the mandate (decision 5, → 428); on `user` it is simply not a
 * supported value (→ 400). RFC update-only-if-exists semantics are a
 * deliberate non-goal until a real app asks.
 */
type ParsedPrecondition = WritePrecondition | { kind: "ifMatchAny" };

/**
 * Parse `If-Match` / `If-None-Match` into a {@link WritePrecondition}, strictly:
 * exactly one strong ETag (`"<digits>"`) or the bare `*`. ETag lists, weak
 * validators (`W/"…"`), a concrete `If-None-Match`, and duplicated headers are
 * all `invalid` (400) — a lenient parse would silently downgrade a client's
 * intended CAS into last-write-wins, the failure this feature exists to catch.
 *
 * The digit string must be CANONICAL and in int64 range: `[1-9]`-led, ≤19
 * digits, ≤ 2^63-1. Leading zeros (`"007"`) would let a validator the server
 * never issued validate (BIGINT comparison is numeric, not octet-equal), and
 * an out-of-range literal makes Postgres raise 22003 at bind time — a client
 * garbage header surfacing as a 502 (review findings 3/5). Rejecting both here
 * also guarantees the stored version's string form is its numeric form, which
 * is what makes the in-memory fake's string comparison faithful to the real
 * store's.
 */
const IF_MATCH_ETAG = /^"([1-9]\d{0,18})"$/;
const INT64_MAX = 9223372036854775807n;

function parsePrecondition(
  req: FastifyRequest,
): { kind: "ok"; precondition: ParsedPrecondition } | { kind: "invalid" } {
  const ifMatch = req.headers["if-match"];
  const ifNoneMatch = req.headers["if-none-match"];
  if (Array.isArray(ifMatch) || Array.isArray(ifNoneMatch)) return { kind: "invalid" };
  if (ifMatch !== undefined && ifNoneMatch !== undefined) return { kind: "invalid" };
  if (ifMatch !== undefined) {
    if (ifMatch === "*") return { kind: "ok", precondition: { kind: "ifMatchAny" } };
    const m = IF_MATCH_ETAG.exec(ifMatch);
    if (!m || m[1] === undefined || BigInt(m[1]) > INT64_MAX) return { kind: "invalid" };
    return { kind: "ok", precondition: { kind: "ifMatch", version: m[1] } };
  }
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch !== "*") return { kind: "invalid" };
    return { kind: "ok", precondition: { kind: "ifNoneMatch" } };
  }
  return { kind: "ok", precondition: { kind: "none" } };
}

/**
 * Coarse, non-reversible abuse-triage metadata for a collection append (§3.2,
 * §7). The IP is one-way hashed (never stored raw); the UA is truncated. Neither
 * is ever exposed to the app — only the portal's owner-facing views may read it.
 */
function triageMeta(req: FastifyRequest): CollectionMeta {
  const meta: CollectionMeta = {};
  if (req.ip) meta.ipHash = createHash("sha256").update(req.ip).digest("hex").slice(0, 16);
  const ua = req.headers["user-agent"];
  if (typeof ua === "string" && ua.length > 0) meta.ua = ua.slice(0, 256);
  return meta;
}

/** Every app-data verb has this shape, which is what makes one wrapper enough. */
type DataVerbHandler = (req: FastifyRequest, reply: FastifyReply, slug: string) => Promise<void>;

/**
 * Wrap each app-data verb in a root span (ADR-0037 decision 4).
 *
 * Done generically rather than as seven near-identical edits: the verbs share a
 * signature, and the only thing that differs is the name — so a wrapper cannot
 * drift the way seven copies would, and a verb added later is instrumented by
 * construction instead of by remembering.
 *
 * {@link withRootSpan} is the right helper here: these handlers `await
 * reply.send(...)` a materialised body rather than piping a stream, so the
 * promise settles after the response is written. The one exception is the
 * collection export, which is documented as materialising the whole CSV
 * (`TODO.md`) — it is still in-handler, so it is still measured correctly.
 */
function withDataSpans<T extends Record<string, DataVerbHandler>>(handlers: T): T {
  const wrapped: Record<string, DataVerbHandler> = {};
  for (const [verb, handler] of Object.entries(handlers)) {
    wrapped[verb] = (req, reply, slug) =>
      withRootSpan(
        SPAN_DATA,
        {
          [ATTR_CAPABILITY]: "data",
          [ATTR_APP_SLUG]: slug,
          [ATTR_DATA_VERB]: verb,
          "http.route": ROUTE_DATA,
        },
        () => handler(req, reply, slug),
        { reply },
      );
  }
  return wrapped as T;
}

export function makeDataHandlers(rt: DataGatewayRuntime) {
  /**
   * Shared preamble for every data verb. Returns the resolved entry + caller, or
   * null after having already responded. `mutation` adds the Origin/CSRF check
   * (state-changing requests only — same-origin GETs may legitimately omit
   * Origin, and a cross-origin read can't be read back without CORS anyway).
   */
  async function preamble(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
    opts: { mutation: boolean },
  ): Promise<{ entry: RegistryEntry; caller: Caller } | null> {
    const entry = resolveServingEntry(rt.registry, slug, reply);
    if (!entry) return null;

    const caller = await rt.resolveCaller(req, reply, entry);
    if (!caller) return null;

    // Per-IP cap for the anonymous tier (public apps): the open surface has no
    // per-user budget to charge (app-data design §7). Checked before the store
    // work; rate-limited requests are *not* metered — a `gateway_calls` row per
    // throttled call would be its own write-amplification vector under a flood.
    if (await anonRateLimited(rt.anonLimiter, req, entry, caller)) {
      sendApiError(reply, 429, "rate_limited", "per-IP request budget exhausted");
      return null;
    }

    if (opts.mutation && !rt.checkOrigin(req, entry)) {
      sendApiError(reply, 403, "forbidden", "Origin not allowed");
      return null;
    }

    if (!rt.store) {
      sendApiError(reply, 503, "capability_unavailable", "data capability is not configured");
      return null;
    }
    if (!entry.data) {
      sendApiError(reply, 403, "forbidden", "this app has no data capability");
      return null;
    }
    return { entry, caller };
  }

  /** User scope (§3.1) requires an authenticated principal — public apps 403. */
  /**
   * The caller as a metering identity, or null after responding.
   *
   * Returns the whole {@link MeterIdentity} rather than the bare oid so that
   * every `meter()` below carries the display half automatically. The oid is
   * still what addresses storage — destructure `identity.userOid` for that, and
   * never let the labels reach `app_data`, which is per-user scoped storage and
   * not an audit table.
   */
  function requireUser(
    reply: FastifyReply,
    entry: RegistryEntry,
    caller: Caller,
  ): MeterIdentity | null {
    if (!entry.data?.user) {
      sendApiError(reply, 403, "forbidden", "this app has no user-scoped data grant");
      return null;
    }
    if (!caller.authenticated) {
      sendApiError(
        reply,
        403,
        "forbidden",
        "user-scoped storage requires a signed-in user (unavailable on public apps)",
      );
      return null;
    }
    return meterIdentity(caller);
  }

  function meter(
    appId: string,
    identity: MeterIdentity,
    model: string,
    outcome: "ok" | "error" | "quota_blocked" | "conflict",
    env: Env,
  ): void {
    // Counter only — this path does not time itself, and `meterGatewayCall`
    // omits the histogram observation rather than recording a zero that would
    // drag every percentile down.
    meterGatewayCall({ appId, capability: "data", outcome });
    rt.usage
      ?.record({
        appId,
        env,
        ...identity,
        capability: "data",
        model,
        inputTokens: 0,
        outputTokens: 0,
        outcome,
      })
      .catch(() => {});
  }

  /**
   * Per-app daily write budget (app-data design §7), block-new like the LLM
   * `dollarsPerDay`: if the app is already at/over `writesPerDay`, refuse the
   * write with 429 and record a `quota_blocked` row. Returns false when blocked
   * (the caller has already responded). Item-size caps are enforced separately;
   * `bytesPerDay` and per-IP rate limiting are deferred knobs (need a stored
   * byte column / shared rate-limit state — see the design doc §7).
   */
  async function admitWrite(
    reply: FastifyReply,
    entry: RegistryEntry,
    identity: MeterIdentity,
    env: Env,
  ): Promise<boolean> {
    const budget = entry.data?.writesPerDay;
    if (budget === undefined) return true;
    const used = rt.usage ? await rt.usage.dataWritesToday(entry.appId, env) : 0;
    if (used >= budget) {
      meter(entry.appId, identity, "quota", "quota_blocked", env);
      sendApiError(reply, 429, "quota_exceeded", "daily write budget exhausted");
      return false;
    }
    return true;
  }

  return withDataSpans({
    async putUser(req: FastifyRequest, reply: FastifyReply, slug: string): Promise<void> {
      const ctx = await preamble(req, reply, slug, { mutation: true });
      if (!ctx) return;
      const identity = requireUser(reply, ctx.entry, ctx.caller);
      if (identity === null) return;
      const key = keyParam(req);
      if (!key) {
        sendApiError(reply, 400, "validation_failed", "invalid key");
        return;
      }
      // The whole JSON body is the value; an explicit `null` is valid, a missing
      // body is not. Size-cap the serialized form (opaque app JSON, §9).
      const value = req.body;
      if (value === undefined) {
        sendApiError(reply, 400, "validation_failed", "missing value body");
        return;
      }
      if (jsonByteLength(value) > MAX_VALUE_BYTES) {
        sendApiError(reply, 400, "validation_failed", `value exceeds ${MAX_VALUE_BYTES} bytes`);
        return;
      }
      const parsed = parsePrecondition(req);
      if (parsed.kind === "invalid" || parsed.precondition.kind === "ifMatchAny") {
        sendApiError(
          reply,
          400,
          "validation_failed",
          'precondition must be If-Match: "<version>" or If-None-Match: *',
        );
        return;
      }
      if (!(await admitWrite(reply, ctx.entry, identity, ctx.caller.env))) return;
      try {
        const result = await rt.store!.putUserKey(
          ctx.entry.appId,
          identity.userOid,
          key,
          value,
          ctx.caller.env,
          parsed.precondition,
        );
        if (result.kind === "conflict") {
          // A stated precondition lost the race. Never charged against
          // writesPerDay (ADR-0041 decision 7 as amended: dataWritesToday
          // counts outcome='ok' only), but VISIBLE — a contended retry loop
          // leaves a conflict row per attempt, not silence. `currentVersion`
          // lets the loser recover in-band — for a sharedWrite-only key it is
          // the ONLY way to learn what to CAS against (review finding 2).
          meter(ctx.entry.appId, identity, "user.put", "conflict", ctx.caller.env);
          sendApiError(
            reply,
            412,
            "conflict",
            "the value changed since your read — re-read and retry",
            { currentVersion: result.currentVersion },
          );
          return;
        }
        meter(ctx.entry.appId, identity, "user.put", "ok", ctx.caller.env);
        await reply
          .header("cache-control", "no-store")
          .header("etag", `"${result.version}"`)
          .send({ key, updatedAt: result.updatedAt });
      } catch (err) {
        meter(ctx.entry.appId, identity, "user.put", "error", ctx.caller.env);
        req.log.warn({ err }, "app-data putUser failed");
        sendApiError(reply, 502, "internal", "failed to store value");
      }
    },

    async getUser(req: FastifyRequest, reply: FastifyReply, slug: string): Promise<void> {
      const ctx = await preamble(req, reply, slug, { mutation: false });
      if (!ctx) return;
      const identity = requireUser(reply, ctx.entry, ctx.caller);
      if (identity === null) return;
      const key = keyParam(req);
      if (!key) {
        sendApiError(reply, 400, "validation_failed", "invalid key");
        return;
      }
      try {
        const stored = await rt.store!.getUserKey(
          ctx.entry.appId,
          identity.userOid,
          key,
          ctx.caller.env,
        );
        meter(ctx.entry.appId, identity, "user.get", "ok", ctx.caller.env);
        if (stored === null) {
          sendApiError(reply, 404, "not_found", "no value for that key");
          return;
        }
        await reply
          .header("cache-control", "no-store")
          .header("etag", `"${stored.version}"`)
          .send({ key, value: stored.value });
      } catch (err) {
        meter(ctx.entry.appId, identity, "user.get", "error", ctx.caller.env);
        req.log.warn({ err }, "app-data getUser failed");
        sendApiError(reply, 502, "internal", "failed to read value");
      }
    },

    async deleteUser(req: FastifyRequest, reply: FastifyReply, slug: string): Promise<void> {
      const ctx = await preamble(req, reply, slug, { mutation: true });
      if (!ctx) return;
      const identity = requireUser(reply, ctx.entry, ctx.caller);
      if (identity === null) return;
      const key = keyParam(req);
      if (!key) {
        sendApiError(reply, 400, "validation_failed", "invalid key");
        return;
      }
      try {
        const deleted = await rt.store!.deleteUserKey(
          ctx.entry.appId,
          identity.userOid,
          key,
          ctx.caller.env,
        );
        meter(ctx.entry.appId, identity, "user.delete", "ok", ctx.caller.env);
        if (!deleted) {
          sendApiError(reply, 404, "not_found", "no value for that key");
          return;
        }
        await reply.status(204).header("cache-control", "no-store").send();
      } catch (err) {
        meter(ctx.entry.appId, identity, "user.delete", "error", ctx.caller.env);
        req.log.warn({ err }, "app-data deleteUser failed");
        sendApiError(reply, 502, "internal", "failed to delete value");
      }
    },

    async listUser(req: FastifyRequest, reply: FastifyReply, slug: string): Promise<void> {
      const ctx = await preamble(req, reply, slug, { mutation: false });
      if (!ctx) return;
      const identity = requireUser(reply, ctx.entry, ctx.caller);
      if (identity === null) return;
      try {
        const keys = await rt.store!.listUserKeys(
          ctx.entry.appId,
          identity.userOid,
          ctx.caller.env,
        );
        meter(ctx.entry.appId, identity, "user.list", "ok", ctx.caller.env);
        await reply.header("cache-control", "no-store").send({ keys });
      } catch (err) {
        meter(ctx.entry.appId, identity, "user.list", "error", ctx.caller.env);
        req.log.warn({ err }, "app-data listUser failed");
        sendApiError(reply, 502, "internal", "failed to list keys");
      }
    },

    /**
     * `POST /_api/data/collections/:name` (§3.2) — append one item. Available to
     * authenticated AND anonymous callers (the harvester is a public app), so
     * the metered/audit user is `anon` when there is no session. There is NO
     * read counterpart — that absence is the security property.
     */
    async postCollection(req: FastifyRequest, reply: FastifyReply, slug: string): Promise<void> {
      const ctx = await preamble(req, reply, slug, { mutation: true });
      if (!ctx) return;
      const name = nameParam(req);
      if (!name) {
        sendApiError(reply, 400, "validation_failed", "invalid collection name");
        return;
      }
      if (!ctx.entry.data?.collections.includes(name)) {
        sendApiError(reply, 403, "forbidden", `collection "${name}" is not declared`);
        return;
      }
      const item = req.body;
      if (item === undefined) {
        sendApiError(reply, 400, "validation_failed", "missing item body");
        return;
      }
      if (jsonByteLength(item) > MAX_VALUE_BYTES) {
        sendApiError(reply, 400, "validation_failed", `item exceeds ${MAX_VALUE_BYTES} bytes`);
        return;
      }
      const identity = meterIdentity(ctx.caller);
      if (!(await admitWrite(reply, ctx.entry, identity, ctx.caller.env))) return;
      try {
        await rt.store!.appendCollection(
          ctx.entry.appId,
          name,
          item,
          // The ledger and this table disagree about anonymity on purpose:
          // `gateway_calls.userOid` is NOT NULL and uses the `"anon"` sentinel,
          // while `app_collection_items.userOid` is nullable and a public
          // submission genuinely has no submitter. So pass null rather than
          // the sentinel — and all three columns or none, which is why this is
          // one argument instead of three.
          ctx.caller.authenticated ? identity : null,
          triageMeta(req),
          ctx.caller.env,
        );
        meter(ctx.entry.appId, identity, "collection.append", "ok", ctx.caller.env);
        // 201, no body — the writer gets no row id and certainly no read-back.
        await reply.status(201).header("cache-control", "no-store").send();
      } catch (err) {
        meter(ctx.entry.appId, identity, "collection.append", "error", ctx.caller.env);
        req.log.warn({ err }, "app-data appendCollection failed");
        sendApiError(reply, 502, "internal", "failed to append item");
      }
    },

    /**
     * `GET /_api/data/shared/:key` (§3.3) — app-shared, world-readable within the
     * app's visibility gate (the preamble already enforces it: anon on public
     * apps, authenticated on internal/group). The key must be declared in
     * `data.sharedRead`.
     */
    async getShared(req: FastifyRequest, reply: FastifyReply, slug: string): Promise<void> {
      const ctx = await preamble(req, reply, slug, { mutation: false });
      if (!ctx) return;
      const identity = meterIdentity(ctx.caller);
      const key = keyParam(req);
      if (!key) {
        sendApiError(reply, 400, "validation_failed", "invalid key");
        return;
      }
      if (!ctx.entry.data?.sharedRead.includes(key)) {
        sendApiError(reply, 403, "forbidden", `key "${key}" is not shared-readable`);
        return;
      }
      try {
        const stored = await rt.store!.getShared(ctx.entry.appId, key, ctx.caller.env);
        meter(ctx.entry.appId, identity, "shared.get", "ok", ctx.caller.env);
        if (stored === null) {
          sendApiError(reply, 404, "not_found", "no value for that key");
          return;
        }
        await reply
          .header("cache-control", "no-store")
          .header("etag", `"${stored.version}"`)
          .send({ key, value: stored.value });
      } catch (err) {
        meter(ctx.entry.appId, identity, "shared.get", "error", ctx.caller.env);
        req.log.warn({ err }, "app-data getShared failed");
        sendApiError(reply, 502, "internal", "failed to read value");
      }
    },

    /**
     * `PUT /_api/data/shared/:key` (§3.3) — write app-shared state. Rare and
     * dangerous (every visitor could mutate it), so the key must be in the
     * narrower `data.sharedWrite` grant. Preconditions are MANDATORY here
     * (ADR-0041 decision 4): a shared write is a race between different,
     * mutually unaware principals, so a PUT carrying neither `If-Match:
     * "<version>"` nor `If-None-Match: *` is refused 428, and `If-Match: *` —
     * last-write-wins dressed as a precondition — is refused the same way
     * (decision 5). A lost race is 412 `conflict`; neither failure is metered
     * or charged (decision 7).
     */
    async putShared(req: FastifyRequest, reply: FastifyReply, slug: string): Promise<void> {
      const ctx = await preamble(req, reply, slug, { mutation: true });
      if (!ctx) return;
      const identity = meterIdentity(ctx.caller);
      const key = keyParam(req);
      if (!key) {
        sendApiError(reply, 400, "validation_failed", "invalid key");
        return;
      }
      if (!ctx.entry.data?.sharedWrite.includes(key)) {
        sendApiError(reply, 403, "forbidden", `key "${key}" is not shared-writable`);
        return;
      }
      const value = req.body;
      if (value === undefined) {
        sendApiError(reply, 400, "validation_failed", "missing value body");
        return;
      }
      if (jsonByteLength(value) > MAX_VALUE_BYTES) {
        sendApiError(reply, 400, "validation_failed", `value exceeds ${MAX_VALUE_BYTES} bytes`);
        return;
      }
      const parsed = parsePrecondition(req);
      if (parsed.kind === "invalid") {
        sendApiError(
          reply,
          400,
          "validation_failed",
          'precondition must be If-Match: "<version>" or If-None-Match: *',
        );
        return;
      }
      if (parsed.precondition.kind === "none" || parsed.precondition.kind === "ifMatchAny") {
        // Fails on the app's FIRST shared write, in dev, with an error naming
        // the fix — the timing that makes a mandatory precondition affordable
        // (ADR-0041 decision 4). Not metered: nothing was written.
        sendApiError(
          reply,
          428,
          "precondition_required",
          'shared writes require If-Match: "<version>" (from your last read) or If-None-Match: * (create-if-absent)',
        );
        return;
      }
      if (!(await admitWrite(reply, ctx.entry, identity, ctx.caller.env))) return;
      try {
        const result = await rt.store!.putShared(
          ctx.entry.appId,
          key,
          value,
          ctx.caller.env,
          parsed.precondition,
        );
        if (result.kind === "conflict") {
          meter(ctx.entry.appId, identity, "shared.put", "conflict", ctx.caller.env);
          sendApiError(
            reply,
            412,
            "conflict",
            "the value changed since your read — re-read and retry",
            { currentVersion: result.currentVersion },
          );
          return;
        }
        meter(ctx.entry.appId, identity, "shared.put", "ok", ctx.caller.env);
        await reply
          .header("cache-control", "no-store")
          .header("etag", `"${result.version}"`)
          .send({ key, updatedAt: result.updatedAt });
      } catch (err) {
        meter(ctx.entry.appId, identity, "shared.put", "error", ctx.caller.env);
        req.log.warn({ err }, "app-data putShared failed");
        sendApiError(reply, 502, "internal", "failed to store value");
      }
    },
  });
}

export type DataHandlers = ReturnType<typeof makeDataHandlers>;
