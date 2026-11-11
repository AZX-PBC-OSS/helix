import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceOAuthRecipeSchema } from "@azx-pbc/shared";
import type { SecretStore } from "@azx-pbc/secret-store";
import { ServiceOAuthManager, type ServiceOAuthTarget } from "./serviceOAuth.js";
import { ServiceOAuthError, type ServiceTokenExchange } from "./serviceOAuthTransport.js";
import { createEgressPool } from "./pool.js";
import { startRecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { EGRESS_SPAN_ATTRS } from "./spanAttributes.js";

const ownerUrl = process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";
const roleUrl = (name: string) => {
  const u = new URL(ownerUrl);
  u.username = name;
  u.password = name;
  return u.href;
};
const owner = new Pool({ connectionString: ownerUrl, max: 2 });
const pool1 = createEgressPool(roleUrl("helix_egress"), { max: 1 });
const pool2 = createEgressPool(roleUrl("helix_egress"), { max: 1 });
const materials = new Map<string, string>();
const destroyed: string[] = [];
const store: SecretStore = {
  async seal(value) {
    const ref = `sealed:${randomUUID()}`;
    materials.set(ref, value);
    return ref;
  },
  async open(ref) {
    const value = materials.get(ref);
    if (!value) throw new Error("missing");
    return value;
  },
  async destroy(ref) {
    destroyed.push(ref);
    materials.delete(ref);
  },
};
const recipe = ServiceOAuthRecipeSchema.parse({
  kind: "oauth-service-account",
  tokenEndpoint: "https://vendor.example/token",
  grantType: "password",
  clientAuthentication: "none",
  scopes: ["read"],
});
const ids: string[] = [];
let target: ServiceOAuthTarget;
const exchange = vi.fn<ServiceTokenExchange>();
const first = new ServiceOAuthManager(pool1, store, exchange);
const second = new ServiceOAuthManager(pool2, store, exchange);
const issued = (refresh: string | undefined = "refresh-SENTINEL") => ({
  access: `access-SENTINEL-${randomUUID()}`,
  refresh,
  expiresAt: new Date(Date.now() + 3_600_000),
});
const expire = () =>
  owner.query(`UPDATE service_oauth_tokens SET "expiresAt" = now() WHERE "secretId" = $1`, [
    target.id,
  ]);
const state = async () =>
  (await owner.query(`SELECT * FROM service_oauth_tokens WHERE "secretId" = $1`, [target.id]))
    .rows[0];

beforeAll(async () => {
  await pool1.query("SELECT 1");
});
beforeEach(async () => {
  exchange.mockReset();
  exchange.mockImplementation(async () => issued());
  const id = randomUUID();
  ids.push(id);
  const material = await store.seal(
    JSON.stringify({
      kind: recipe.kind,
      username: "username-SENTINEL",
      password: "password-SENTINEL",
    }),
  );
  target = { id, material, env: "prod", credentialGeneration: 1, recipe };
  await owner.query(
    `INSERT INTO app_secrets(id, scope, env, name, material, injection, "createdBy") VALUES ($1,'global','prod',$2,$3,$4,'test')`,
    [id, `oauth-${id}`, material, recipe],
  );
});
afterAll(async () => {
  await first.close();
  await second.close();
  await owner.query("DELETE FROM app_secrets WHERE id = ANY($1::uuid[])", [ids]);
  await first.sweep();
  await Promise.all([owner.end(), pool1.end(), pool2.end()]);
});

describe("service-account shared recovery", () => {
  it("coalesces initial acquisition across replicas and reuses the shared token", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).resolve(target)),
    );
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.value)).size).toBe(1);
    expect((await second.resolve(target)).recovered).toBe(false);
    expect(JSON.stringify(await state())).not.toContain("SENTINEL");
  });
  it("refreshes once, preserving omitted refresh material, and retires only displaced material", async () => {
    await first.resolve(target);
    const old = await state();
    await expire();
    exchange.mockImplementation(async () => issued(undefined));
    // Explicit undefined is the fixture helper's default; remove it to model omission.
    exchange.mockImplementation(async () => ({
      access: "new-access",
      expiresAt: new Date(Date.now() + 3_600_000),
    }));
    await Promise.all([first.resolve(target), second.resolve(target)]);
    expect(exchange).toHaveBeenCalledTimes(2);
    expect((await state()).refresh).toBe(old.refresh);
    await first.sweep();
    expect(destroyed).toContain(old.access);
    expect(destroyed).not.toContain(old.refresh);
  });
  it("falls back after rejected/uncertain refresh and clears a prior grant's refresh on omission", async () => {
    await first.resolve(target);
    await expire();
    exchange.mockImplementationOnce(async () => {
      throw new ServiceOAuthError("needs_attention");
    });
    exchange.mockImplementationOnce(async () => ({
      access: "new-grant",
      expiresAt: new Date(Date.now() + 3_600_000),
    }));
    expect((await first.resolve(target)).value).toBe("new-grant");
    expect(exchange.mock.calls[1]?.[2]).toBe("refresh-SENTINEL");
    expect(exchange.mock.calls[2]?.[2]).toBeUndefined();
    expect((await state()).refresh).toBeNull();
  });
  it("does not replay a refresh token after a crashed attempt", async () => {
    await first.resolve(target);
    await owner.query(
      `UPDATE service_oauth_tokens SET status='recovering', attempt=$2 WHERE "secretId"=$1`,
      [target.id, randomUUID()],
    );
    await second.resolve(target);
    expect(exchange.mock.calls[1]?.[2]).toBeUndefined();
  });
  it("persists cooldown and credential rejection so waiting replicas do not repeat login", async () => {
    exchange.mockImplementation(async () => {
      throw new ServiceOAuthError("needs_attention");
    });
    const results = await Promise.allSettled([first.resolve(target), second.resolve(target)]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect((await state()).status).toBe("needs_attention");
    await expect(first.resolve(target)).rejects.toMatchObject({ outcome: "needs_attention" });
  });
  it("honors shared rate-limit cooldown without a fallback exchange", async () => {
    await first.resolve(target);
    await expire();
    exchange.mockImplementation(async () => {
      throw new ServiceOAuthError("temporary_failure", 120_000, false);
    });
    await expect(first.resolve(target)).rejects.toMatchObject({ outcome: "temporary_failure" });
    await expect(second.resolve(target)).rejects.toMatchObject({ outcome: "temporary_failure" });
    expect(exchange).toHaveBeenCalledTimes(2);
    expect((await state()).retryAfter.getTime()).toBeGreaterThan(Date.now() + 110_000);
  });
  it("cools down after an issued token is rejected at the resource", async () => {
    const token = await first.resolve(target);
    await first.reject(target, token.generation, true);
    await expect(second.resolve(target)).rejects.toMatchObject({ outcome: "temporary_failure" });
    expect(exchange).toHaveBeenCalledTimes(1);
    expect((await state()).retryAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it("ignores delayed rejection of an older generation", async () => {
    const a = await first.resolve(target);
    await expire();
    const b = await second.resolve(target);
    await first.reject(target, a.generation);
    expect((await first.resolve(target, a.generation)).value).toBe(b.value);
    expect(exchange).toHaveBeenCalledTimes(2);
  });
  it.each(["rotate", "delete"])("fences publication racing credential %s", async (action) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    exchange.mockImplementation(async () => {
      entered();
      await hold;
      return issued();
    });
    const work = first.resolve(target);
    await ready;
    if (action === "rotate")
      await owner.query(`UPDATE app_secrets SET material = $2 WHERE id = $1`, [
        target.id,
        await store.seal("replacement"),
      ]);
    else await owner.query(`DELETE FROM app_secrets WHERE id = $1`, [target.id]);
    release();
    await expect(work).rejects.toMatchObject({ outcome: "not_authorized" });
    expect(await state()).toBeUndefined();
    await first.sweep();
  });
  it("retains cleanup records through deletion and retries failed destruction", async () => {
    await first.resolve(target);
    const old = await state();
    await owner.query("DELETE FROM app_secrets WHERE id = $1", [target.id]);
    const fail = vi.spyOn(store, "destroy").mockRejectedValueOnce(new Error("vault down"));
    await first.sweep();
    fail.mockRestore();
    await first.sweep();
    expect(destroyed).toContain(old.access);
    expect(destroyed).toContain(old.refresh);
  });
  it("retires partial seals without returning a half-published token", async () => {
    const original = store.seal.bind(store);
    const sealed: string[] = [];
    const fault = vi.spyOn(store, "seal").mockImplementation(async (value) => {
      if (value.startsWith("refresh")) throw new Error("vault down");
      const ref = await original(value);
      sealed.push(ref);
      return ref;
    });
    try {
      await expect(first.resolve(target)).rejects.toMatchObject({ outcome: "temporary_failure" });
      expect((await state()).access).toBeNull();
      await first.sweep();
      expect(sealed.length).toBe(1);
      expect(destroyed).toContain(sealed[0]);
    } finally {
      fault.mockRestore();
    }
  });

  it("does not publish after losing the lock-holding database session", async () => {
    const checkedOut = await pool1.connect();
    const pid = (await checkedOut.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    checkedOut.release();
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    exchange.mockImplementation(async () => {
      entered();
      await hold;
      return issued();
    });
    const work = first.resolve(target);
    await ready;
    await owner.query("SELECT pg_terminate_backend($1)", [pid]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await expect(work).rejects.toMatchObject({ outcome: "temporary_failure" });
    expect((await state()).access).toBeNull();
    expect((await state()).status).toBe("recovering");
    exchange.mockImplementation(async () => issued());
    expect((await second.resolve(target)).value).toContain("access-SENTINEL");
    expect(exchange.mock.calls[1]?.[2]).toBeUndefined();
  });

  it("keeps token state out of edge and limits egress writes to token state", async () => {
    const edge = new Pool({ connectionString: roleUrl("helix_edge"), max: 1 });
    try {
      for (const table of [
        "service_oauth_tokens",
        "service_oauth_retirements",
        "secret_connection_bindings",
      ]) {
        await expect(edge.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
      }
      await expect(
        pool1.query(`UPDATE app_secrets SET "credentialGeneration" = 9 WHERE id=$1`, [target.id]),
      ).rejects.toThrow(/permission denied/);
      await expect(pool1.query(`DELETE FROM secret_connection_bindings`)).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await edge.end();
    }
  });
  it("records bounded physical exchanges and never credential or token attributes", async () => {
    const recording = startRecordingTelemetry();
    try {
      await first.resolve(target);
      const spans = recording.spans();
      expect(spans.length).toBeGreaterThanOrEqual(2);
      for (const span of spans) {
        expect(
          JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }),
        ).not.toContain("SENTINEL");
        expect(span.events).toHaveLength(0);
        for (const key of Object.keys(span.attributes))
          expect(new Set<string>(EGRESS_SPAN_ATTRS).has(key)).toBe(true);
      }
    } finally {
      await recording.restore();
    }
  });
});
