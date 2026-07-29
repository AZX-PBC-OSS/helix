import { describe, expect, it } from "vitest";
import { KeyVaultError, KeyVaultSecretStore } from "./keyvault.js";

const VAULT = "https://helix-test-kvc.vault.azure.net";

/** Options every test shares: no real sleeping, no real clock, no real network. */
function opts(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return {
    vaultUrl: VAULT,
    getToken: async () => "bearer-token",
    fetchImpl,
    sleep: async () => {},
    retryBaseMs: 0,
    ...extra,
  };
}

/**
 * An in-memory Key Vault good enough for the data-plane calls we make: versioned
 * `PUT`, version-pinned `GET`, whole-name `DELETE`.
 */
function fakeVault() {
  const secrets = new Map<string, Map<string, string>>();
  let version = 0;
  const requests: { method: string; url: string; auth: string | undefined }[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    requests.push({ method, url: url.toString(), auth: headers.get("authorization") ?? undefined });

    const parts = url.pathname.split("/").filter(Boolean); // ["secrets", name, version?]
    const name = parts[1] ?? "";

    if (method === "PUT") {
      version += 1;
      const v = version.toString(16).padStart(32, "0");
      const value = (JSON.parse(String(init?.body)) as { value: string }).value;
      const versions = secrets.get(name) ?? new Map<string, string>();
      versions.set(v, value);
      secrets.set(name, versions);
      return json(200, { id: `${VAULT}/secrets/${name}/${v}`, value });
    }
    if (method === "GET") {
      const value = secrets.get(name)?.get(parts[2] ?? "");
      if (value === undefined) return json(404, { error: { code: "SecretNotFound" } });
      return json(200, { id: url.toString(), value });
    }
    if (method === "DELETE") {
      if (!secrets.delete(name)) return json(404, { error: { code: "SecretNotFound" } });
      return json(200, { id: `${VAULT}/deletedsecrets/${name}` });
    }
    return json(405, { error: { code: "MethodNotAllowed" } });
  };

  return { fetchImpl, secrets, requests };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Replays a fixed list of responses (or thrown errors), counting calls. */
function scripted(steps: (Response | Error | (() => Response))[]) {
  let i = 0;
  const fetchImpl: typeof fetch = async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step === undefined) throw new Error("scripted() ran out of responses");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step() : step.clone();
  };
  return { fetchImpl, calls: () => i };
}

describe("KeyVaultSecretStore — material contract", () => {
  it("seals to kv:<name>/<version> with an opaque random name", async () => {
    const vault = fakeVault();
    const store = new KeyVaultSecretStore(opts(vault.fetchImpl));

    const material = await store.seal("sk_live_abc123");
    expect(material).toMatch(/^kv:hx-[0-9a-f]{32}\/[0-9a-f]+$/);
    // The reference is not the secret: a DB dump alone reveals nothing.
    expect(material).not.toContain("sk_live_abc123");
    // Nor does it leak the app or the operator-facing secret name into the vault.
    expect(material).not.toMatch(/anthropic|app|prod/);
  });

  it("round-trips seal → open", async () => {
    const vault = fakeVault();
    const store = new KeyVaultSecretStore(opts(vault.fetchImpl));
    const material = await store.seal("sk_live_abc123");
    expect(await store.open(material)).toBe("sk_live_abc123");
  });

  it("mints a distinct name per seal, so rotation never overwrites in place", async () => {
    const vault = fakeVault();
    const store = new KeyVaultSecretStore(opts(vault.fetchImpl));
    const a = await store.seal("v1");
    const b = await store.seal("v2");
    expect(a).not.toBe(b);
    expect(await store.open(a)).toBe("v1");
    expect(await store.open(b)).toBe("v2");
  });

  it("sends the bearer token and the pinned api-version", async () => {
    const vault = fakeVault();
    const store = new KeyVaultSecretStore(opts(vault.fetchImpl));
    await store.open(await store.seal("v"));
    for (const req of vault.requests) {
      expect(req.auth).toBe("Bearer bearer-token");
      expect(new URL(req.url).searchParams.get("api-version")).toBe("7.4");
    }
  });

  it("refuses dev `aesgcm:` material — no cross-scheme downgrade", async () => {
    const vault = fakeVault();
    const store = new KeyVaultSecretStore(opts(vault.fetchImpl));
    await expect(store.open("aesgcm:00:11:22")).rejects.toThrow(/malformed/);
    expect(vault.requests).toHaveLength(0);
  });

  it("rejects malformed material without touching the network", async () => {
    const vault = fakeVault();
    const store = new KeyVaultSecretStore(opts(vault.fetchImpl));
    for (const bad of ["", "kv:", "kv:name", "not-a-blob", "kv:/version", "kv:name/"]) {
      await expect(store.open(bad)).rejects.toThrow(/malformed/);
    }
    expect(vault.requests).toHaveLength(0);
  });

  it("rejects material that would escape the vault URL path", async () => {
    const vault = fakeVault();
    const store = new KeyVaultSecretStore(opts(vault.fetchImpl));
    for (const bad of [
      "kv:../../keys/signing/abc",
      "kv:name/../../other",
      "kv:na%2fme/v1",
      "kv:name?x=1/v1",
      "kv:name/v1?api-version=2016-10-01",
    ]) {
      await expect(store.open(bad)).rejects.toThrow(/malformed/);
    }
    expect(vault.requests).toHaveLength(0);
  });
});

describe("KeyVaultSecretStore — version-pinned cache", () => {
  it("serves a second open from cache (one vault call)", async () => {
    const vault = fakeVault();
    const store = new KeyVaultSecretStore(opts(vault.fetchImpl));
    const material = await store.seal("v");
    const gets = () => vault.requests.filter((r) => r.method === "GET").length;

    expect(await store.open(material)).toBe("v");
    expect(await store.open(material)).toBe("v");
    expect(gets()).toBe(1);
  });

  it("re-fetches after the TTL expires", async () => {
    const vault = fakeVault();
    let now = 1_000_000;
    const store = new KeyVaultSecretStore(
      opts(vault.fetchImpl, { now: () => now, cacheTtlMs: 60_000 }),
    );
    const material = await store.seal("v");
    const gets = () => vault.requests.filter((r) => r.method === "GET").length;

    await store.open(material);
    now += 59_000;
    await store.open(material);
    expect(gets()).toBe(1);
    now += 2_000; // past the TTL
    await store.open(material);
    expect(gets()).toBe(2);
  });

  it("single-flights a concurrent burst into one vault call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET") !== "GET") {
        return json(200, { id: `${VAULT}/secrets/hx-x/0a`, value: "v" });
      }
      calls += 1;
      await gate;
      return json(200, { id: `${VAULT}/secrets/hx-x/0a`, value: "v" });
    };
    const store = new KeyVaultSecretStore(opts(fetchImpl));
    const material = await store.seal("v");

    const all = Promise.all([store.open(material), store.open(material), store.open(material)]);
    release();
    expect(await all).toEqual(["v", "v", "v"]);
    expect(calls).toBe(1);
  });

  it("does not cache failures", async () => {
    const s = scripted([
      json(200, { id: `${VAULT}/secrets/hx-a/0a`, value: "v" }), // seal
      json(500, { error: { code: "InternalError" } }),
      json(500, { error: { code: "InternalError" } }),
      json(500, { error: { code: "InternalError" } }),
      json(200, { id: `${VAULT}/secrets/hx-a/0a`, value: "v" }),
    ]);
    const store = new KeyVaultSecretStore(opts(s.fetchImpl));
    const material = await store.seal("v");
    await expect(store.open(material)).rejects.toThrow(/500/);
    expect(await store.open(material)).toBe("v");
  });

  it("destroy() invalidates the cached plaintext", async () => {
    const vault = fakeVault();
    const store = new KeyVaultSecretStore(opts(vault.fetchImpl));
    const material = await store.seal("v");
    expect(await store.open(material)).toBe("v");

    await store.destroy(material);
    // The vault entry is gone and the cache no longer answers for it.
    await expect(store.open(material)).rejects.toMatchObject({ status: 404 });
  });

  it("evicts the least-recently-used entry past cacheMax", async () => {
    const vault = fakeVault();
    const store = new KeyVaultSecretStore(opts(vault.fetchImpl, { cacheMax: 2 }));
    const [a, b, c] = [await store.seal("a"), await store.seal("b"), await store.seal("c")];
    const gets = () => vault.requests.filter((r) => r.method === "GET").length;

    await store.open(a);
    await store.open(b);
    await store.open(a); // refresh `a`, making `b` the LRU victim
    await store.open(c); // evicts `b`
    expect(gets()).toBe(3);

    await store.open(a); // still cached
    expect(gets()).toBe(3);
    await store.open(b); // evicted → re-fetch
    expect(gets()).toBe(4);
  });
});

describe("KeyVaultSecretStore — timeout and retry", () => {
  it("retries a 429 and honours Retry-After", async () => {
    const waits: number[] = [];
    const s = scripted([
      json(429, { error: { code: "Throttled" } }, { "retry-after": "1" }),
      json(200, { id: `${VAULT}/secrets/hx-a/0a`, value: "v" }),
    ]);
    const store = new KeyVaultSecretStore(
      opts(s.fetchImpl, {
        sleep: async (ms: number) => {
          waits.push(ms);
        },
      }),
    );
    expect(await store.open("kv:hx-a/0a")).toBe("v");
    expect(s.calls()).toBe(2);
    expect(waits).toEqual([1000]);
  });

  it("retries 5xx and gives up after the configured attempts", async () => {
    const s = scripted([json(503, { error: { code: "ServiceUnavailable" } })]);
    const store = new KeyVaultSecretStore(opts(s.fetchImpl));
    await expect(store.open("kv:hx-a/0a")).rejects.toMatchObject({ status: 503 });
    expect(s.calls()).toBe(3); // 1 attempt + 2 retries
  });

  it("retries a transport error", async () => {
    const s = scripted([
      new Error("ECONNRESET"),
      json(200, { id: `${VAULT}/secrets/hx-a/0a`, value: "v" }),
    ]);
    const store = new KeyVaultSecretStore(opts(s.fetchImpl));
    expect(await store.open("kv:hx-a/0a")).toBe("v");
    expect(s.calls()).toBe(2);
  });

  it("does not retry 403 — an RBAC failure must fail fast", async () => {
    const s = scripted([json(403, { error: { code: "Forbidden" } })]);
    const store = new KeyVaultSecretStore(opts(s.fetchImpl));
    await expect(store.open("kv:hx-a/0a")).rejects.toMatchObject({ status: 403 });
    expect(s.calls()).toBe(1);
  });

  it("does not retry 404, and surfaces it distinctly from 403", async () => {
    const s = scripted([json(404, { error: { code: "SecretNotFound" } })]);
    const store = new KeyVaultSecretStore(opts(s.fetchImpl));
    const err = await store.open("kv:hx-a/0a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyVaultError);
    expect((err as KeyVaultError).status).toBe(404);
    expect((err as KeyVaultError).code).toBe("SecretNotFound");
    expect(s.calls()).toBe(1);
  });

  it("stops retrying once the total deadline is spent", async () => {
    let now = 0;
    const s = scripted([json(503, { error: { code: "ServiceUnavailable" } })]);
    const store = new KeyVaultSecretStore(
      opts(s.fetchImpl, {
        now: () => now,
        openTotalMs: 100,
        // Each attempt "takes" 80ms, so the second exhausts the 100ms budget.
        sleep: async () => {
          now += 80;
        },
      }),
    );
    await expect(store.open("kv:hx-a/0a")).rejects.toThrow();
    expect(s.calls()).toBe(2);
  });

  it("aborts an attempt that exceeds the per-attempt timeout", async () => {
    let aborts = 0;
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborts += 1;
          reject(new Error("aborted"));
        });
      });
    const store = new KeyVaultSecretStore(opts(fetchImpl, { openTimeoutMs: 5, retries: 0 }));
    await expect(store.open("kv:hx-a/0a")).rejects.toThrow(/failed/);
    expect(aborts).toBe(1);
  });

  it("never puts the secret value in an error message", async () => {
    const s = scripted([json(500, { error: { code: "InternalError" } })]);
    const store = new KeyVaultSecretStore(opts(s.fetchImpl));
    const err = await store.seal("sk_live_abc123").catch((e: unknown) => e);
    expect(String(err)).not.toContain("sk_live_abc123");
  });
});

describe("KeyVaultSecretStore — destroy", () => {
  it("deletes the vault entry", async () => {
    const vault = fakeVault();
    const store = new KeyVaultSecretStore(opts(vault.fetchImpl));
    const material = await store.seal("v");
    await store.destroy(material);
    expect(vault.secrets.size).toBe(0);
  });

  it("treats an already-deleted entry as success (idempotent)", async () => {
    const vault = fakeVault();
    const store = new KeyVaultSecretStore(opts(vault.fetchImpl));
    const material = await store.seal("v");
    await store.destroy(material);
    await expect(store.destroy(material)).resolves.toBeUndefined();
  });

  it("drops the cache even when the vault delete fails, then rejects", async () => {
    const s = scripted([
      json(200, { id: `${VAULT}/secrets/hx-a/0a`, value: "v" }), // seal
      json(200, { id: `${VAULT}/secrets/hx-a/0a`, value: "v" }), // open → cached
      json(403, { error: { code: "Forbidden" } }), // delete denied
      json(403, { error: { code: "Forbidden" } }), // subsequent open
    ]);
    const store = new KeyVaultSecretStore(opts(s.fetchImpl));
    const material = await store.seal("v");
    expect(await store.open(material)).toBe("v");

    await expect(store.destroy(material)).rejects.toMatchObject({ status: 403 });
    // No warm plaintext left behind for a secret the operator asked us to release.
    await expect(store.open(material)).rejects.toMatchObject({ status: 403 });
  });
});
