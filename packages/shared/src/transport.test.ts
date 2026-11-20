import { describe, expect, it, vi } from "vitest";
import {
  assertInternalTransport,
  assertPlatformTransport,
  initializePlatformTransport,
} from "./transport.js";

const production = { NODE_ENV: "production" };
describe("internal transport policy", () => {
  it("requires HTTPS in production and preserves local HTTP", () => {
    expect(() => assertInternalTransport("http://service:8080", "SERVICE", production)).toThrow(
      "HTTPS required",
    );
    expect(() => assertInternalTransport("https://service", "SERVICE", production)).not.toThrow();
    expect(() => assertInternalTransport("http://localhost:8080", "SERVICE", {})).not.toThrow();
  });
  it("limits mesh exemptions to exact origins", () => {
    const env = {
      ...production,
      HELIX_INTERNAL_TRANSPORT_MODE: "mesh",
      HELIX_MESH_HTTP_ORIGINS: '["http://service:8080"]',
    };
    expect(() => assertInternalTransport("http://service:8080/path", "SERVICE", env)).not.toThrow();
    for (const url of ["http://service:8081", "http://other:8080"])
      expect(() => assertInternalTransport(url, "SERVICE", env)).toThrow();
  });
  it.each([
    '["http://*.example"]',
    '["http://service/path"]',
    '["http://user:password@service"]',
    "{}",
    "invalid",
  ])("rejects malformed allowlists", (origins) => {
    expect(() =>
      assertPlatformTransport({
        ...production,
        HELIX_INTERNAL_TRANSPORT_MODE: "mesh",
        HELIX_MESH_HTTP_ORIGINS: origins,
      }),
    ).toThrow();
  });
  it("checks nested jobs targets without leaking values", () => {
    expect(() =>
      assertPlatformTransport({
        ...production,
        EDGE_JOBS_CONFIG: '{"servers":{"jobs":{"endpoint":"http://secret.example"}}}',
      }),
    ).toThrow("EDGE_JOBS_CONFIG: HTTPS required");
  });
  it("does not exempt vaults or disabled verification", () => {
    expect(() =>
      assertPlatformTransport({ ...production, NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
    ).toThrow();
    expect(() =>
      assertPlatformTransport({
        ...production,
        PLATFORM_VAULT_URL: "http://vault",
        HELIX_INTERNAL_TRANSPORT_MODE: "mesh",
        HELIX_MESH_HTTP_ORIGINS: '["http://vault"]',
      }),
    ).toThrow();
  });
});

describe("service ownership and database requirements", () => {
  it("does not validate another service's inherited settings", () => {
    expect(() =>
      assertPlatformTransport(
        {
          ...production,
          EDGE_EGRESS_URL: "http://edge-only",
          EDGE_DATABASE_URL: "postgres://other/db",
          JOBS_DATABASE_URL: "postgres://jobs/db?sslmode=verify-full",
          JOBS_EDGE_PROD_URL: "https://edge",
        },
        "jobs",
      ),
    ).not.toThrow();
  });
  it.each([
    "",
    "?sslmode=require",
    "?sslmode=disable",
    "?sslmode=verify-full&ssl=false",
    "?sslmode=verify-full&sslmode=disable",
  ])("rejects ambiguous or insecure database configuration %s", (query) => {
    expect(() =>
      assertPlatformTransport(
        { ...production, JOBS_DATABASE_URL: `postgres://jobs/db${query}` },
        "jobs",
      ),
    ).toThrow("sslmode=verify-full required");
  });
});

it("records mode and refusal without destination or credential data", () => {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    initializePlatformTransport(
      {
        NODE_ENV: "production",
        HELIX_INTERNAL_TRANSPORT_MODE: "mesh",
        HELIX_MESH_HTTP_ORIGINS: '["http://sensitive.example"]',
        EDGE_EGRESS_URL: "http://sensitive.example/path",
      },
      "edge",
    );
    expect(String(out.mock.calls)).toContain('"mode":"mesh"');
    expect(String(out.mock.calls)).not.toContain("sensitive");
    expect(() =>
      initializePlatformTransport(
        { NODE_ENV: "production", EDGE_EGRESS_URL: "http://credential:secret@sensitive.example" },
        "edge",
      ),
    ).toThrow();
    expect(String(err.mock.calls)).toContain('"outcome":"refused"');
    expect(String(err.mock.calls)).not.toMatch(/credential|secret|sensitive/);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
});
