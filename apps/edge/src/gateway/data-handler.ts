import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiErrorCode } from "@azx-pbc/shared";
import type { EdgeConfig } from "../config.js";
import type { RegistryReader } from "../registry/projection.js";
import { ANON_USER_OID, type Caller, type CallerResolver } from "../auth/gate.js";
import type { RegistryEntry } from "../registry/projection.js";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import { isSameOrigin } from "../auth/validate.js";
import type { AppDataStore, CollectionMeta } from "./data.js";
import { anonRateLimited, type IpRateLimiter } from "./ipRateLimiter.js";
import type { UsageStore } from "./usage.js";

/**
 * `/_api/data/*` — the gateway's app-data capability (architecture §6.1,
 * app-data design §3/§5). Every handler reuses the LLM gateway's preamble
 * (`llm.ts`): resolve serving entry → resolve caller (gate, or anon on public
 * apps) → Origin/CSRF check on mutations → capability/scope check → body
 * validation → store call → meter. Reads send `cache-control: no-store`.
 *
 * The §3.2 collection invariant is structural: there is no list/read verb for
 * collections here, and the store has no method to enumerate them — covered by
 * an adversarial test asserting those paths 404/405.
 */

export interface DataGatewayRuntime {
  config: EdgeConfig;
  registry: RegistryReader;
  resolveCaller: CallerResolver;
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
): void {
  reply
    .status(status)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send({ error: { code, message } });
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

    if (opts.mutation && !isSameOrigin(req.headers.origin, rt.config, entry.slug)) {
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
  function requireUser(reply: FastifyReply, entry: RegistryEntry, caller: Caller): string | null {
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
    return caller.oid;
  }

  function meter(
    appId: string,
    userOid: string,
    model: string,
    outcome: "ok" | "error" | "quota_blocked",
  ): void {
    rt.usage
      ?.record({
        appId,
        userOid,
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
    meterOid: string,
  ): Promise<boolean> {
    const budget = entry.data?.writesPerDay;
    if (budget === undefined) return true;
    const used = rt.usage ? await rt.usage.dataWritesToday(entry.appId) : 0;
    if (used >= budget) {
      meter(entry.appId, meterOid, "quota", "quota_blocked");
      sendApiError(reply, 429, "quota_exceeded", "daily write budget exhausted");
      return false;
    }
    return true;
  }

  return {
    async putUser(req: FastifyRequest, reply: FastifyReply, slug: string): Promise<void> {
      const ctx = await preamble(req, reply, slug, { mutation: true });
      if (!ctx) return;
      const oid = requireUser(reply, ctx.entry, ctx.caller);
      if (oid === null) return;
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
      if (!(await admitWrite(reply, ctx.entry, oid))) return;
      try {
        const updatedAt = await rt.store!.putUserKey(ctx.entry.appId, oid, key, value);
        meter(ctx.entry.appId, oid, "user.put", "ok");
        await reply.header("cache-control", "no-store").send({ key, updatedAt });
      } catch (err) {
        meter(ctx.entry.appId, oid, "user.put", "error");
        req.log.warn({ err }, "app-data putUser failed");
        sendApiError(reply, 502, "internal", "failed to store value");
      }
    },

    async getUser(req: FastifyRequest, reply: FastifyReply, slug: string): Promise<void> {
      const ctx = await preamble(req, reply, slug, { mutation: false });
      if (!ctx) return;
      const oid = requireUser(reply, ctx.entry, ctx.caller);
      if (oid === null) return;
      const key = keyParam(req);
      if (!key) {
        sendApiError(reply, 400, "validation_failed", "invalid key");
        return;
      }
      try {
        const value = await rt.store!.getUserKey(ctx.entry.appId, oid, key);
        meter(ctx.entry.appId, oid, "user.get", "ok");
        if (value === null) {
          sendApiError(reply, 404, "not_found", "no value for that key");
          return;
        }
        await reply.header("cache-control", "no-store").send({ key, value });
      } catch (err) {
        meter(ctx.entry.appId, oid, "user.get", "error");
        req.log.warn({ err }, "app-data getUser failed");
        sendApiError(reply, 502, "internal", "failed to read value");
      }
    },

    async deleteUser(req: FastifyRequest, reply: FastifyReply, slug: string): Promise<void> {
      const ctx = await preamble(req, reply, slug, { mutation: true });
      if (!ctx) return;
      const oid = requireUser(reply, ctx.entry, ctx.caller);
      if (oid === null) return;
      const key = keyParam(req);
      if (!key) {
        sendApiError(reply, 400, "validation_failed", "invalid key");
        return;
      }
      try {
        const deleted = await rt.store!.deleteUserKey(ctx.entry.appId, oid, key);
        meter(ctx.entry.appId, oid, "user.delete", "ok");
        if (!deleted) {
          sendApiError(reply, 404, "not_found", "no value for that key");
          return;
        }
        await reply.status(204).header("cache-control", "no-store").send();
      } catch (err) {
        meter(ctx.entry.appId, oid, "user.delete", "error");
        req.log.warn({ err }, "app-data deleteUser failed");
        sendApiError(reply, 502, "internal", "failed to delete value");
      }
    },

    async listUser(req: FastifyRequest, reply: FastifyReply, slug: string): Promise<void> {
      const ctx = await preamble(req, reply, slug, { mutation: false });
      if (!ctx) return;
      const oid = requireUser(reply, ctx.entry, ctx.caller);
      if (oid === null) return;
      try {
        const keys = await rt.store!.listUserKeys(ctx.entry.appId, oid);
        meter(ctx.entry.appId, oid, "user.list", "ok");
        await reply.header("cache-control", "no-store").send({ keys });
      } catch (err) {
        meter(ctx.entry.appId, oid, "user.list", "error");
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
      const userOid = ctx.caller.authenticated ? ctx.caller.oid : null;
      const meterOid = userOid ?? ANON_USER_OID;
      if (!(await admitWrite(reply, ctx.entry, meterOid))) return;
      try {
        await rt.store!.appendCollection(ctx.entry.appId, name, item, userOid, triageMeta(req));
        meter(ctx.entry.appId, meterOid, "collection.append", "ok");
        // 201, no body — the writer gets no row id and certainly no read-back.
        await reply.status(201).header("cache-control", "no-store").send();
      } catch (err) {
        meter(ctx.entry.appId, meterOid, "collection.append", "error");
        req.log.warn({ err }, "app-data appendCollection failed");
        sendApiError(reply, 502, "internal", "failed to append item");
      }
    },

    /**
     * `GET /_api/data/shared/:key` (§3.3) — app-shared, world-readable within the
     * app's visibility gate (the preamble already enforces it: anon on public
     * apps, authenticated on private/group). The key must be declared in
     * `data.sharedRead`.
     */
    async getShared(req: FastifyRequest, reply: FastifyReply, slug: string): Promise<void> {
      const ctx = await preamble(req, reply, slug, { mutation: false });
      if (!ctx) return;
      const meterOid = ctx.caller.authenticated ? ctx.caller.oid : ANON_USER_OID;
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
        const value = await rt.store!.getShared(ctx.entry.appId, key);
        meter(ctx.entry.appId, meterOid, "shared.get", "ok");
        if (value === null) {
          sendApiError(reply, 404, "not_found", "no value for that key");
          return;
        }
        await reply.header("cache-control", "no-store").send({ key, value });
      } catch (err) {
        meter(ctx.entry.appId, meterOid, "shared.get", "error");
        req.log.warn({ err }, "app-data getShared failed");
        sendApiError(reply, 502, "internal", "failed to read value");
      }
    },

    /**
     * `PUT /_api/data/shared/:key` (§3.3) — write app-shared state. Rare and
     * dangerous (every visitor could mutate it), so the key must be in the
     * narrower `data.sharedWrite` grant. Last-write-wins (design doc §9).
     */
    async putShared(req: FastifyRequest, reply: FastifyReply, slug: string): Promise<void> {
      const ctx = await preamble(req, reply, slug, { mutation: true });
      if (!ctx) return;
      const meterOid = ctx.caller.authenticated ? ctx.caller.oid : ANON_USER_OID;
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
      if (!(await admitWrite(reply, ctx.entry, meterOid))) return;
      try {
        const updatedAt = await rt.store!.putShared(ctx.entry.appId, key, value);
        meter(ctx.entry.appId, meterOid, "shared.put", "ok");
        await reply.header("cache-control", "no-store").send({ key, updatedAt });
      } catch (err) {
        meter(ctx.entry.appId, meterOid, "shared.put", "error");
        req.log.warn({ err }, "app-data putShared failed");
        sendApiError(reply, 502, "internal", "failed to store value");
      }
    },
  };
}

export type DataHandlers = ReturnType<typeof makeDataHandlers>;
