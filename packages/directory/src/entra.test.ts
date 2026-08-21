import { describe, expect, it, vi } from "vitest";
import { EntraDirectory } from "./entra.js";
import { DirectoryError, GRAPH_GROUP_PERMISSION, MAX_SEARCH_RESULTS } from "./provider.js";

/**
 * No network, no real clock, no real sleep — the same discipline as
 * `secret-store/src/keyvault.test.ts`. Every assertion here is about a query
 * shape or a status classification that ADR-0040 settled empirically
 * (`docs/reviews/2026-08-20-entra-group-permissions-probe.md`), so these are
 * regression pins on decisions, not on plumbing.
 */

/** Options every test shares. */
function opts(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return {
    getToken: async () => "bearer-token",
    fetchImpl,
    sleep: async () => {},
    retryBaseMs: 0,
    ...extra,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Record every request, answer each with the next scripted response. */
function scripted(responses: Array<Response | Error | (() => Response)>) {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
  let i = 0;
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    // `.clone()` is load-bearing: a Response body can be read exactly once, and
    // the retry tests deliberately serve the last entry repeatedly. Without it a
    // second read throws, the provider catches that as a *transport* error, and
    // a status-classification assertion silently tests the wrong branch.
    return typeof next === "function" ? next() : (next as Response).clone();
  });
  return { impl: impl as unknown as typeof fetch, calls, count: () => i };
}

const GROUP_A = "11111111-1111-4111-8111-111111111111";
const GROUP_B = "22222222-2222-4222-8222-222222222222";

describe("EntraDirectory.searchGroups — the query shape ADR-0040 hinged on", () => {
  it("uses $search with $count and the mandatory ConsistencyLevel header", async () => {
    const s = scripted([
      json(200, { value: [{ id: GROUP_A, displayName: "Engineering", securityEnabled: true }] }),
    ]);
    const dir = new EntraDirectory(opts(s.impl));
    const res = await dir.searchGroups("eng", 10);

    expect(res).toEqual({
      available: true,
      value: [{ id: GROUP_A, displayName: "Engineering", securityEnabled: true }],
    });
    const call = s.calls[0];
    // $search, NOT startswith: a prefix filter silently omits groups whose name
    // carries the term as a later word (probe: 3 hits vs 2), which in a picker
    // is a correctness bug rather than worse ranking.
    expect(decodeURIComponent(call?.url ?? "")).toContain('$search="displayName:eng"');
    expect(call?.url).toContain("$count=true");
    expect(call?.url).not.toContain("startswith");
    // Without this header Graph answers 400 Request_UnsupportedQuery. It belongs
    // in the package so no call site can forget it.
    expect(call?.headers.get("consistencylevel")).toBe("eventual");
    expect(call?.headers.get("authorization")).toBe("Bearer bearer-token");
  });

  it("refuses a term shorter than the minimum without calling Graph", async () => {
    const s = scripted([json(200, { value: [] })]);
    const dir = new EntraDirectory(opts(s.impl));
    await expect(dir.searchGroups("en", 10)).rejects.toThrow(/at least 3 characters/);
    expect(s.count()).toBe(0);
  });

  // The term is interpolated inside a quoted OData expression, so a double quote
  // is the one character that can break out and rewrite the query.
  it("refuses a term that could break out of the quoted search expression", async () => {
    const s = scripted([json(200, { value: [] })]);
    const dir = new EntraDirectory(opts(s.impl));
    await expect(dir.searchGroups('eng" OR displayName:a', 10)).rejects.toThrow(/cannot contain/);
    await expect(dir.searchGroups("eng\\x", 10)).rejects.toThrow(/cannot contain/);
    expect(s.count()).toBe(0);
  });

  it("clamps $top to the package cap however much the caller asks for", async () => {
    const s = scripted([json(200, { value: [] })]);
    const dir = new EntraDirectory(opts(s.impl));
    await dir.searchGroups("eng", 10_000);
    expect(s.calls[0]?.url).toContain(`$top=${MAX_SEARCH_RESULTS}`);
  });

  // The probe's nastiest finding: Graph can answer 200 with the right number of
  // objects and every property null. Coercing to "" renders blank rows that read
  // as a UI defect; skipping keeps the list honest.
  it("drops rows with a null or missing displayName rather than coercing them", async () => {
    const s = scripted([
      json(200, {
        value: [
          { id: GROUP_A, displayName: null, securityEnabled: null },
          { id: GROUP_B, displayName: "Product", securityEnabled: true },
          { id: null, displayName: "Nameless", securityEnabled: true },
          "not-an-object",
        ],
      }),
    ]);
    const dir = new EntraDirectory(opts(s.impl));
    const res = await dir.searchGroups("eng", 10);
    expect(res).toEqual({
      available: true,
      value: [{ id: GROUP_B, displayName: "Product", securityEnabled: true }],
    });
  });
});

describe("EntraDirectory.getGroups", () => {
  it("batches through getByIds scoped to groups", async () => {
    const s = scripted([
      json(200, { value: [{ id: GROUP_A, displayName: "Engineering", securityEnabled: true }] }),
    ]);
    const dir = new EntraDirectory(opts(s.impl));
    const res = await dir.getGroups([GROUP_A, GROUP_B]);

    // The flag rides along when the payload carried one; `getByIds` does return
    // full objects, so this is the common case rather than the exception.
    expect(res).toEqual({
      available: true,
      value: [{ id: GROUP_A, displayName: "Engineering", securityEnabled: true }],
    });
    expect(s.calls[0]?.method).toBe("POST");
    expect(s.calls[0]?.url).toContain("/directoryObjects/getByIds");
    expect(JSON.parse(s.calls[0]?.body ?? "{}")).toEqual({
      ids: [GROUP_A, GROUP_B],
      types: ["group"],
    });
  });

  // Actor.groups is the UNION of the `groups` and `roles` claims, so App Role
  // values ride alongside GUIDs. One of those reaching Graph is a 400 that fails
  // the whole batch and takes the caller's real groups down with it.
  it("drops non-GUID ids before calling Graph", async () => {
    const s = scripted([json(200, { value: [] })]);
    const dir = new EntraDirectory(opts(s.impl));
    await dir.getGroups(["platform-admin", GROUP_A, "eng-team"]);
    expect(JSON.parse(s.calls[0]?.body ?? "{}")).toEqual({ ids: [GROUP_A], types: ["group"] });
  });

  it("does not call Graph at all when nothing is GUID-shaped", async () => {
    const s = scripted([json(200, { value: [] })]);
    const dir = new EntraDirectory(opts(s.impl));
    await expect(dir.getGroups(["platform-admin", "eng-team"])).resolves.toEqual({
      available: true,
      value: [],
    });
    expect(s.count()).toBe(0);
  });

  it("dedupes ids", async () => {
    const s = scripted([json(200, { value: [] })]);
    const dir = new EntraDirectory(opts(s.impl));
    await dir.getGroups([GROUP_A, GROUP_A, GROUP_B]);
    expect(JSON.parse(s.calls[0]?.body ?? "{}").ids).toEqual([GROUP_A, GROUP_B]);
  });

  // A stale stored id is an ordinary state, not an error: the probe confirmed a
  // deleted group is simply absent from the batch response.
  it("omits ids that do not resolve instead of failing", async () => {
    const s = scripted([json(200, { value: [] })]);
    const dir = new EntraDirectory(opts(s.impl));
    await expect(dir.getGroups([GROUP_A])).resolves.toEqual({ available: true, value: [] });
  });
});

describe("EntraDirectory status classification", () => {
  // ADR-0040 decision 8. This is the whole reason the interface returns an
  // outcome rather than throwing: absent consent is an expected, permanent,
  // operator-fixable state the Access tab must degrade around, not an error.
  it("reports 403 Authorization_RequestDenied as unavailable, naming the permission", async () => {
    const s = scripted([json(403, { error: { code: "Authorization_RequestDenied" } })]);
    const dir = new EntraDirectory(opts(s.impl));
    const res = await dir.searchGroups("eng", 10);
    expect(res.available).toBe(false);
    if (res.available) throw new Error("unreachable");
    expect(res.reason).toBe("no-consent");
    expect(res.detail).toContain(GRAPH_GROUP_PERMISSION);
    // Terminal — retrying a consent failure cannot change the answer.
    expect(s.count()).toBe(1);
  });

  it("still throws on a 403 that is not a consent failure", async () => {
    const s = scripted([json(403, { error: { code: "Request_BadRequest" } })]);
    const dir = new EntraDirectory(opts(s.impl));
    await expect(dir.searchGroups("eng", 10)).rejects.toThrow(DirectoryError);
  });

  it("does not retry a 400 — retrying cannot change the answer", async () => {
    const s = scripted([json(400, { error: { code: "Request_UnsupportedQuery" } })]);
    const dir = new EntraDirectory(opts(s.impl));
    await expect(dir.searchGroups("eng", 10)).rejects.toMatchObject({
      status: 400,
      code: "Request_UnsupportedQuery",
    });
    expect(s.count()).toBe(1);
  });

  it("retries a 429 and succeeds", async () => {
    const s = scripted([
      json(429, { error: { code: "TooManyRequests" } }, { "retry-after": "0" }),
      json(200, { value: [{ id: GROUP_A, displayName: "Engineering", securityEnabled: true }] }),
    ]);
    const dir = new EntraDirectory(opts(s.impl));
    const res = await dir.searchGroups("eng", 10);
    expect(res.available).toBe(true);
    expect(s.count()).toBe(2);
  });

  it("retries a 5xx up to the retry budget, then throws", async () => {
    const s = scripted([json(503, { error: { code: "ServiceUnavailable" } })]);
    const dir = new EntraDirectory(opts(s.impl, { retries: 2 }));
    await expect(dir.searchGroups("eng", 10)).rejects.toMatchObject({ status: 503 });
    expect(s.count()).toBe(3); // initial + 2 retries
  });

  // An unsatisfiable Retry-After must fail now rather than sleep the whole
  // remaining budget to accomplish nothing (keyvault.ts's #backoff reasoning).
  it("gives up rather than sleeping past its deadline on a long Retry-After", async () => {
    const sleep = vi.fn(async () => {});
    const s = scripted([json(429, {}, { "retry-after": "600" })]);
    const dir = new EntraDirectory(opts(s.impl, { sleep, totalMs: 1_000 }));
    await expect(dir.searchGroups("eng", 10)).rejects.toMatchObject({ status: 429 });
    expect(sleep).not.toHaveBeenCalled();
    expect(s.count()).toBe(1);
  });

  it("retries a transport error", async () => {
    const s = scripted([
      new Error("socket hang up"),
      json(200, { value: [{ id: GROUP_A, displayName: "Engineering", securityEnabled: true }] }),
    ]);
    const dir = new EntraDirectory(opts(s.impl));
    await expect(dir.searchGroups("eng", 10)).resolves.toMatchObject({ available: true });
    expect(s.count()).toBe(2);
  });

  it("throws on a 2xx with an unparseable body", async () => {
    const s = scripted([new Response("<html>proxy</html>", { status: 200 })]);
    const dir = new EntraDirectory(opts(s.impl));
    await expect(dir.searchGroups("eng", 10)).rejects.toThrow(/unparseable body/);
  });

  it("never puts the token in a thrown message", async () => {
    const s = scripted([json(500, { error: { code: "Boom" } })]);
    const dir = new EntraDirectory(opts(s.impl, { getToken: async () => "super-secret-token" }));
    await expect(dir.searchGroups("eng", 10)).rejects.toSatisfy(
      (e: Error) => !e.message.includes("super-secret-token"),
    );
  });
});

describe("EntraDirectory reports the security flag honestly", () => {
  it("omits it from a resolve whose payload did not carry one", async () => {
    const s = scripted([json(200, { value: [{ id: GROUP_A, displayName: "Engineering" }] })]);
    const dir = new EntraDirectory(opts(s.impl));
    const res = await dir.getGroups([GROUP_A]);
    if (!res.available) throw new Error("unreachable");
    // Absent, NOT `true`. A defaulted flag is indistinguishable from a real
    // answer, which made the same group render eligible in one view and
    // ineligible in another depending on query resolution order.
    expect(res.value).toEqual([{ id: GROUP_A, displayName: "Engineering" }]);
    expect("securityEnabled" in res.value[0]!).toBe(false);
  });

  it("defaults it to eligible on a search, where it is explicitly $selected", async () => {
    const s = scripted([json(200, { value: [{ id: GROUP_A, displayName: "Engineering" }] })]);
    const dir = new EntraDirectory(opts(s.impl));
    const res = await dir.searchGroups("eng", 10);
    if (!res.available) throw new Error("unreachable");
    // Here an absent flag is anomalous rather than unfetched, so the group is
    // offered rather than silently marked ineligible.
    expect(res.value).toEqual([{ id: GROUP_A, displayName: "Engineering", securityEnabled: true }]);
  });

  it("passes a false flag through untouched", async () => {
    const s = scripted([
      json(200, { value: [{ id: GROUP_A, displayName: "Role", securityEnabled: false }] }),
    ]);
    const dir = new EntraDirectory(opts(s.impl));
    const res = await dir.getGroups([GROUP_A]);
    if (!res.available) throw new Error("unreachable");
    expect(res.value[0]?.securityEnabled).toBe(false);
  });
});

describe("EntraDirectory when it cannot get a token", () => {
  /**
   * The failure a developer hits first: `AZURE_CLIENT_ID` set with no managed
   * identity behind it, no `az login`, or the wrong tenant. Before this it threw,
   * which the portal's error plugin turned into an opaque **500 on the group
   * picker** — indistinguishable from a Graph outage, and pointing at nothing.
   */
  it("reports no-credential rather than throwing", async () => {
    const s = scripted([json(200, { value: [] })]);
    const dir = new EntraDirectory(
      opts(s.impl, {
        getToken: async () => {
          throw new Error("ManagedIdentityCredential authentication failed");
        },
      }),
    );
    const res = await dir.searchGroups("eng", 10);
    expect(res.available).toBe(false);
    if (res.available) throw new Error("unreachable");
    expect(res.reason).toBe("no-credential");
    // It must NOT say "ask an administrator for GroupMember.Read.All" — that is a
    // different problem with a different owner.
    expect(res.detail).not.toContain(GRAPH_GROUP_PERMISSION);
    expect(res.detail).toMatch(/AZURE_CLIENT_ID|az login/);
    // Never reached Graph, so nothing was called.
    expect(s.count()).toBe(0);
  });

  it("retries a transient token failure before giving up on it", async () => {
    let calls = 0;
    const s = scripted([
      json(200, { value: [{ id: GROUP_A, displayName: "Engineering", securityEnabled: true }] }),
    ]);
    const dir = new EntraDirectory(
      opts(s.impl, {
        getToken: async () => {
          calls += 1;
          if (calls === 1) throw new Error("transient");
          return "token";
        },
      }),
    );
    // A blip must not be reported as a misconfiguration.
    await expect(dir.searchGroups("eng", 10)).resolves.toMatchObject({ available: true });
    expect(calls).toBe(2);
  });
});
