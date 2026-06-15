import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { fetchJson, PortalApiError } from "./client";
import { setToken, clearToken } from "../auth/tokenStore";

const PingSchema = z.object({ ok: z.boolean() });

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("fetchJson", () => {
  it("zod-parses successful responses", async () => {
    mockFetch(200, { ok: true });
    await expect(fetchJson(PingSchema, "/api/v1/ping")).resolves.toEqual({ ok: true });
  });

  it("rejects 2xx bodies that don't match the schema", async () => {
    mockFetch(200, { nope: 1 });
    await expect(fetchJson(PingSchema, "/api/v1/ping")).rejects.toThrow();
  });

  it("maps the error envelope onto a typed PortalApiError", async () => {
    mockFetch(409, { error: { code: "slug_taken", message: 'slug "x" is already taken' } });
    const err = await fetchJson(PingSchema, "/api/v1/apps", { method: "POST", body: {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PortalApiError);
    expect((err as PortalApiError).code).toBe("slug_taken");
    expect((err as PortalApiError).status).toBe(409);
  });

  it("falls back to an internal error on a non-envelope failure body", async () => {
    mockFetch(502, "bad gateway");
    const err = await fetchJson(PingSchema, "/api/v1/ping").catch((e: unknown) => e);
    expect((err as PortalApiError).code).toBe("internal");
    expect((err as PortalApiError).status).toBe(502);
  });

  it("attaches the bearer token when one is stored", async () => {
    setToken("tok-123");
    const fn = mockFetch(200, { ok: true });
    await fetchJson(PingSchema, "/api/v1/ping");
    const headers = (fn.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
  });

  it("sends no Authorization header when logged out", async () => {
    const fn = mockFetch(200, { ok: true });
    await fetchJson(PingSchema, "/api/v1/ping");
    const headers = (fn.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("drops an expired stored token instead of sending it", async () => {
    setToken("stale", -10);
    const fn = mockFetch(200, { ok: true });
    await fetchJson(PingSchema, "/api/v1/ping");
    const headers = (fn.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});
