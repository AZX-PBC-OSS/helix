import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_HEADER_SAFELIST } from "./fetch.js";
import {
  loggerOption,
  parseRequestId,
  redactUrl,
  REQUEST_ID_HEADER,
  requestIdOptions,
  resolveLogLevel,
} from "./logging.js";

describe("redactUrl — platform-minted credentials", () => {
  it("redacts the Appendix A handoff token", () => {
    expect(redactUrl("/_auth/complete?token=eyJhbGciOiJIUzI1NiJ9.abc.def")).toBe(
      "/_auth/complete?token=REDACTED",
    );
  });

  it("redacts the OIDC authorization code on both callbacks, keeping state", () => {
    // The edge's auth host...
    expect(redactUrl("/callback?code=SplxlOBeZQQYbYS6WxSbIA&state=xyz")).toBe(
      "/callback?code=REDACTED&state=xyz",
    );
    // ...and the portal SPA's own redirect URI.
    expect(redactUrl("/auth/callback?code=SplxlOBeZQQYbYS6WxSbIA&state=xyz")).toBe(
      "/auth/callback?code=REDACTED&state=xyz",
    );
  });

  it("redacts IdP-chosen error_description but keeps the enumerated error", () => {
    expect(redactUrl("/callback?error=invalid_request&error_description=free+text&state=x")).toBe(
      "/callback?error=invalid_request&error_description=REDACTED&state=x",
    );
  });

  it("leaves URLs without a query untouched", () => {
    expect(redactUrl("/")).toBe("/");
    expect(redactUrl("/assets/app.js")).toBe("/assets/app.js");
  });

  it("preserves parameter order and every non-sensitive value", () => {
    expect(redactUrl("/x?a=1&token=secret&b=2&code=secret2&c=3")).toBe(
      "/x?a=1&token=REDACTED&b=2&code=REDACTED&c=3",
    );
  });

  it("redacts repeats of the same parameter", () => {
    expect(redactUrl("/x?token=one&token=two")).toBe("/x?token=REDACTED&token=REDACTED");
  });

  it("matches the name case-insensitively and through percent-encoding", () => {
    expect(redactUrl("/x?TOKEN=secret")).toBe("/x?TOKEN=REDACTED");
    expect(redactUrl("/x?%74oken=secret")).toBe("/x?%74oken=REDACTED");
    expect(redactUrl("/x?+token+=secret")).toBe("/x?+token+=REDACTED");
  });

  it("does not redact parameters that merely contain a sensitive name", () => {
    expect(redactUrl("/x?tokenish=fine&mycode=fine&rd=/token")).toBe(
      "/x?tokenish=fine&mycode=fine&rd=/token",
    );
  });

  it("keeps `=`-bearing values intact when redacting (splits on the first `=`)", () => {
    expect(redactUrl("/x?token=a=b=c&next=/a?b=c")).toBe("/x?token=REDACTED&next=/a?b=c");
  });

  it("survives malformed query strings", () => {
    expect(redactUrl("/x?")).toBe("/x?");
    expect(redactUrl("/x?token")).toBe("/x?token"); // no value to leak
    expect(redactUrl("/x?%zz=1&token=secret")).toBe("/x?%zz=1&token=REDACTED");
    expect(redactUrl("/x?&&token=secret&&")).toBe("/x?&&token=REDACTED&&");
  });
});

describe("redactUrl — the third-party credential names", () => {
  it("redacts the common API-key and signed-URL conventions", () => {
    for (const name of [
      "api_key",
      "apikey",
      "key",
      "sig",
      "signature",
      "secret",
      "client_secret",
      "password",
      "passphrase",
      "assertion",
      "authorization",
      "session",
      "sid",
      "access_token",
      "refresh_token",
      "id_token",
    ]) {
      expect(redactUrl(`/x?${name}=SENTINEL`)).toBe(`/x?${name}=REDACTED`);
    }
  });

  it("redacts an Azure SAS query while keeping its non-secret parts", () => {
    expect(redactUrl("/x?sv=2021-08-06&se=2026-01-01&sp=r&sig=abc%2Bdef")).toBe(
      "/x?sv=2021-08-06&se=2026-01-01&sp=r&sig=REDACTED",
    );
  });
});

describe("redactUrl — no unscanned windows", () => {
  it("scans the fragment too (a fragment on the wire is hand-crafted)", () => {
    expect(redactUrl("/x?a=1#token=SUPERSECRET")).toBe("/x?a=1#token=REDACTED");
  });

  it("splits on `;` as well as `&`", () => {
    expect(redactUrl("/_auth/complete?rd=/;token=SECRET")).toBe(
      "/_auth/complete?rd=/;token=REDACTED",
    );
    expect(redactUrl("/x?a=1;token=SECRET;b=2")).toBe("/x?a=1;token=REDACTED;b=2");
  });
});

/**
 * `/_api/fetch/<target>`: the target is an arbitrary third-party URL the app
 * chose, so no name list covers it — the rule is to keep origin + path and drop
 * the query wholesale. Cases mirror the ones the review probed.
 */
describe("redactUrl — the fetch-proxy target", () => {
  it("A: drops the target's query, which the shim splices in unencoded", () => {
    expect(
      redactUrl("/_api/fetch/https://api.example.com/v1?api_key=sk-live-DEADBEEF&token=t"),
    ).toBe("/_api/fetch/https://api.example.com/v1?REDACTED");
  });

  it("B: covers a percent-encoded target, where the query hides in the path", () => {
    expect(
      redactUrl("/_api/fetch/https%3A%2F%2Fapi.example.com%2Fv1%3Faccess_token%3Dsk-live-DEADBEEF"),
    ).toBe("/_api/fetch/https://api.example.com/v1?REDACTED");
  });

  it("D: drops `user:pass@` userinfo (origin excludes it)", () => {
    expect(redactUrl("/_api/fetch/https://user:pa55w0rd@api.example.com/v1")).toBe(
      "/_api/fetch/https://api.example.com/v1",
    );
  });

  it("keeps origin + path when the target has no query", () => {
    expect(redactUrl("/_api/fetch/https://api.example.com/v1/models")).toBe(
      "/_api/fetch/https://api.example.com/v1/models",
    );
  });

  it("covers the dev gateway's slug-prefixed route", () => {
    expect(redactUrl("/demo/_api/fetch/https://api.example.com/v1?sig=SECRET")).toBe(
      "/demo/_api/fetch/https://api.example.com/v1?REDACTED",
    );
  });

  it("drops an unparseable target entirely (it can only 400)", () => {
    expect(redactUrl("/_api/fetch/not-a-url?token=x")).toBe("/_api/fetch/REDACTED");
    expect(redactUrl("/_api/fetch/")).toBe("/_api/fetch/REDACTED");
  });

  it("matches the prefix in the PATH only — a query value can't divert the scan", () => {
    // Otherwise this URL takes the fetch branch, whose `head` is everything
    // before the prefix — carrying the token straight back into the log.
    expect(redactUrl("/x?token=SECRET&y=/_api/fetch/https://api.example.com/")).toBe(
      "/x?token=REDACTED&y=/_api/fetch/https://api.example.com/",
    );
  });
});

describe("loggerOption", () => {
  it("is off under NODE_ENV=test", () => {
    expect(loggerOption("test")).toBe(false);
  });

  it("carries the redacting serializer otherwise", () => {
    for (const env of ["production", "development"]) {
      const option = loggerOption(env);
      expect(option).not.toBe(false);
      expect(typeof (option as { serializers: { req: unknown } }).serializers.req).toBe("function");
    }
  });

  it("logs when NODE_ENV is unset — only `test` is quiet", () => {
    const saved = process.env.NODE_ENV;
    try {
      delete process.env.NODE_ENV;
      expect(loggerOption()).not.toBe(false);
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    }
  });

  it("mirrors Fastify's default req fields, with the url redacted", () => {
    const option = loggerOption("production");
    expect(option).not.toBe(false);
    const serialize = (option as { serializers: { req: (r: unknown) => unknown } }).serializers.req;

    expect(
      serialize({
        method: "GET",
        url: "/_auth/complete?token=SECRET",
        host: "demo.local.helix.azxlabs.io",
        ip: "203.0.113.7",
        headers: { "accept-version": "1.x" },
        socket: { remotePort: 54321 },
      }),
    ).toEqual({
      method: "GET",
      url: "/_auth/complete?token=REDACTED",
      version: "1.x",
      host: "demo.local.helix.azxlabs.io",
      remoteAddress: "203.0.113.7",
      remotePort: 54321,
    });
  });

  it("does not throw when the socket is gone (pino would lose the whole line)", () => {
    const option = loggerOption("production");
    expect(option).not.toBe(false);
    const serialize = (option as { serializers: { req: (r: unknown) => { remotePort?: number } } })
      .serializers.req;

    expect(serialize({ method: "GET", url: "/", headers: {} }).remotePort).toBeUndefined();
  });

  it("drops a duplicated accept-version header rather than logging an array", () => {
    const option = loggerOption("production");
    expect(option).not.toBe(false);
    const serialize = (option as { serializers: { req: (r: unknown) => { version?: string } } })
      .serializers.req;

    expect(
      serialize({ method: "GET", url: "/", headers: { "accept-version": ["1.x", "2.x"] } }).version,
    ).toBeUndefined();
  });
});

describe("resolveLogLevel", () => {
  /** Swallow the warn line so a passing test doesn't print to the suite's stderr. */
  function captureStderr(): { text: () => string } {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    return { text: () => spy.mock.calls.map((c) => String(c[0])).join("") };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to info when nothing is set", () => {
    expect(resolveLogLevel("EDGE", {})).toBe("info");
  });

  it("prefers the service-prefixed var over the shared one", () => {
    // The point of the two-step fallback: raise the edge without raising the
    // portal and egress with it.
    expect(resolveLogLevel("EDGE", { EDGE_LOG_LEVEL: "debug", LOG_LEVEL: "warn" })).toBe("debug");
    expect(resolveLogLevel("PORTAL", { EDGE_LOG_LEVEL: "debug", LOG_LEVEL: "warn" })).toBe("warn");
  });

  it("falls through to the shared var", () => {
    expect(resolveLogLevel("EGRESS", { LOG_LEVEL: "trace" })).toBe("trace");
  });

  it("tolerates case and surrounding whitespace", () => {
    expect(resolveLogLevel("EDGE", { LOG_LEVEL: "  DEBUG " })).toBe("debug");
  });

  it("accepts silent", () => {
    expect(resolveLogLevel("EDGE", { LOG_LEVEL: "silent" })).toBe("silent");
  });

  it("treats an empty value as unset rather than invalid", () => {
    const stderr = captureStderr();
    expect(resolveLogLevel("EDGE", { LOG_LEVEL: "" })).toBe("info");
    expect(stderr.text()).toBe("");
  });

  it("falls back LOUDLY on an unknown level, and does not throw", () => {
    // The boot-safety property. pino throws synchronously on an unknown level
    // and `Fastify({ logger })` runs at module scope, so throwing here would
    // mean a typo in an env var stops the service booting.
    const stderr = captureStderr();
    expect(() => resolveLogLevel("EDGE", { LOG_LEVEL: "infoo" })).not.toThrow();
    expect(resolveLogLevel("EDGE", { LOG_LEVEL: "infoo" })).toBe("info");
    expect(stderr.text()).toContain('"event":"log.level_invalid"');
    expect(stderr.text()).toContain('"value":"infoo"');
  });
});

describe("loggerOption levels", () => {
  it("stays quiet under test whatever the level says", () => {
    // The test-quiet branch wins: a LOG_LEVEL in the ambient env must not turn
    // the suite's logging back on.
    expect(loggerOption("test", { env: { LOG_LEVEL: "debug" } })).toBe(false);
  });

  it("carries the resolved level to pino", () => {
    const option = loggerOption("production", { prefix: "EDGE", env: { EDGE_LOG_LEVEL: "warn" } });
    expect(option).not.toBe(false);
    if (option === false) throw new Error("unreachable");
    expect(option.level).toBe("warn");
  });

  it("omits `mixin` entirely when none is supplied, rather than passing undefined", () => {
    const option = loggerOption("production", { env: {} });
    if (option === false) throw new Error("unreachable");
    expect("mixin" in option).toBe(false);
  });

  it("forwards a supplied mixin by reference and never calls it", () => {
    // `loggerOption` must stay free of any OpenTelemetry import — it hands the
    // function to pino and has no opinion about what it returns.
    const mixin = vi.fn(() => ({ trace_id: "abc" }));
    const option = loggerOption("production", { env: {}, mixin });
    if (option === false) throw new Error("unreachable");
    expect(option.mixin).toBe(mixin);
    expect(mixin).not.toHaveBeenCalled();
  });
});

describe("parseRequestId", () => {
  const VALID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  it("accepts a UUID, normalising case and whitespace", () => {
    expect(parseRequestId(VALID)).toBe(VALID);
    expect(parseRequestId(` ${VALID.toUpperCase()} `)).toBe(VALID);
  });

  it("rejects anything that is not UUID-shaped", () => {
    // The value lands on every log line for the request and is retained for 30
    // days, so the rejections that matter are the ones that would forge a log
    // entry or bloat the field — not merely "wrong format".
    expect(parseRequestId("a\nb")).toBeNull();
    expect(parseRequestId(`${VALID}\ninjected`)).toBeNull();
    expect(parseRequestId("x".repeat(8192))).toBeNull();
    expect(parseRequestId("\u001b[31mred")).toBeNull();
    expect(parseRequestId("not-a-uuid")).toBeNull();
    expect(parseRequestId("")).toBeNull();
  });

  it("rejects a repeated header, which arrives as an array", () => {
    expect(parseRequestId([VALID, VALID])).toBeNull();
    expect(parseRequestId(undefined)).toBeNull();
    expect(parseRequestId(42)).toBeNull();
  });
});

describe("requestIdOptions", () => {
  const VALID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  it("never sets requestIdHeader, in either mode", () => {
    // A drift guard: Fastify 5 already defaults this to false, but the obvious
    // next edit is `requestIdHeader: "x-request-id"`, and on the edge that
    // would take an id straight from untrusted app code.
    expect(requestIdOptions().requestIdHeader).toBe(false);
    expect(requestIdOptions({ trustInbound: true }).requestIdHeader).toBe(false);
  });

  it("mints a fresh id and ignores the caller's, by default", () => {
    const { genReqId } = requestIdOptions();
    const id = genReqId({ headers: { [REQUEST_ID_HEADER]: VALID } });
    expect(id).not.toBe(VALID);
    expect(parseRequestId(id)).toBe(id);
  });

  it("mints a distinct id per request", () => {
    // Fastify's own generator is a per-process counter, so two replicas both
    // start at `req-1` and every restart resets.
    const { genReqId } = requestIdOptions();
    const ids = new Set(Array.from({ length: 50 }, () => genReqId({ headers: {} })));
    expect(ids.size).toBe(50);
  });

  it("adopts a valid inbound id under trustInbound — the egress case", () => {
    const { genReqId } = requestIdOptions({ trustInbound: true });
    expect(genReqId({ headers: { [REQUEST_ID_HEADER]: VALID } })).toBe(VALID);
  });

  it("mints a fresh id rather than adopting a malformed one, even under trustInbound", () => {
    const { genReqId } = requestIdOptions({ trustInbound: true });
    const id = genReqId({ headers: { [REQUEST_ID_HEADER]: "a\nb" } });
    expect(id).not.toContain("\n");
    expect(parseRequestId(id)).toBe(id);
  });

  it("keeps the correlation header off the upstream safelist", () => {
    // `REQUEST_HEADER_SAFELIST` is what egress forwards to a third-party
    // upstream. Our internal request id is nobody else's business, and this is
    // one word away from regressing.
    expect(REQUEST_HEADER_SAFELIST).not.toContain(REQUEST_ID_HEADER);
  });
});
