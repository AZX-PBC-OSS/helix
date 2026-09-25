import { describe, expect, it } from "vitest";
import {
  CancelRequestSchema,
  CancelResponseSchema,
  ConsultRequestSchema,
  ConsultResponseSchema,
  CONSENT_ATTEMPT_TTL_SECONDS,
} from "./consent.js";

/**
 * The consent operation contracts (I-02 T-0012, ADR-0002 §Shared ground).
 * Every consumer — the edge's start route and dev gateway (T-0014/T-0016),
 * the helper's cancellation (T-0017), the callback (T-0020) — parses through
 * these schemas, so the tests pin the one definition: canonicalization,
 * strictness, and the identity union that pins the tier without an env field.
 */

const STATE = "a".repeat(43);

describe("ConsultRequestSchema", () => {
  it("canonicalizes the opener origin and keeps the callback URL verbatim", () => {
    const req = ConsultRequestSchema.parse({
      identity: { kind: "user", userOid: "oid" },
      appSlug: "my-app",
      providerRef: "asana",
      openerOrigin: "https://app.example.test/",
      callbackUrl: "https://auth.example.test/connections/callback",
    });
    expect(req.openerOrigin).toBe("https://app.example.test");
    expect(req.callbackUrl).toBe("https://auth.example.test/connections/callback");
  });

  it("carries no env field — the tier is the identity kind, and unknown keys are refused", () => {
    expect(
      ConsultRequestSchema.safeParse({
        identity: { kind: "user", userOid: "oid", env: "prod" },
        appSlug: "my-app",
        providerRef: "asana",
        openerOrigin: "https://app.example.test",
        callbackUrl: "https://auth.example.test/connections/callback",
      }).success,
    ).toBe(false);
    expect(
      ConsultRequestSchema.safeParse({
        identity: { kind: "user", userOid: "oid" },
        appSlug: "my-app",
        providerRef: "asana",
        openerOrigin: "https://app.example.test",
        callbackUrl: "https://auth.example.test/connections/callback",
        state: "smuggled",
      }).success,
    ).toBe(false);
  });

  it("requires the dev identity's nonce and refuses a dev identity without one", () => {
    const base = {
      appSlug: "my-app",
      providerRef: "asana",
      openerOrigin: "https://app.example.test",
      callbackUrl: "https://auth.example.test/connections/callback",
    };
    expect(
      ConsultRequestSchema.safeParse({
        ...base,
        identity: { kind: "dev", developerOid: "dev-oid", nonce: "0123456789abcdef" },
      }).success,
    ).toBe(true);
    expect(
      ConsultRequestSchema.safeParse({
        ...base,
        identity: { kind: "dev", developerOid: "dev-oid" },
      }).success,
    ).toBe(false);
  });

  it("canonicalizes a sloppy opener to its bare origin, and refuses a non-http(s) callback", () => {
    const base = {
      identity: { kind: "user", userOid: "oid" },
      appSlug: "my-app",
      providerRef: "asana",
      callbackUrl: "https://auth.example.test/connections/callback",
    };
    const sloppy = ConsultRequestSchema.parse({
      ...base,
      openerOrigin: "https://app.example.test/some/page",
    });
    expect(sloppy.openerOrigin).toBe("https://app.example.test");
    expect(
      ConsultRequestSchema.safeParse({
        ...base,
        callbackUrl: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });
});

describe("ConsultResponseSchema / CancelRequestSchema / CancelResponseSchema", () => {
  it("accepts exactly the three consult outcomes", () => {
    expect(ConsultResponseSchema.safeParse({ outcome: "already_connected" }).success).toBe(true);
    expect(ConsultResponseSchema.safeParse({ outcome: "not_available" }).success).toBe(true);
    expect(
      ConsultResponseSchema.safeParse({
        outcome: "started",
        authorizeUrl: "https://vendor.example/oauth/authorize?state=x",
      }).success,
    ).toBe(true);
    expect(ConsultResponseSchema.safeParse({ outcome: "started" }).success).toBe(false);
    expect(ConsultResponseSchema.safeParse({ outcome: "signin_required" }).success).toBe(false);
  });

  it("bounds the cancel request's state and answer set", () => {
    expect(
      CancelRequestSchema.safeParse({ identity: { kind: "user", userOid: "oid" }, state: STATE })
        .success,
    ).toBe(true);
    expect(
      CancelRequestSchema.safeParse({ identity: { kind: "user", userOid: "oid" }, state: "short" })
        .success,
    ).toBe(false);
    expect(CancelResponseSchema.safeParse({ outcome: "cancelled" }).success).toBe(true);
    expect(CancelResponseSchema.safeParse({ outcome: "not_cancellable" }).success).toBe(true);
    expect(CancelResponseSchema.safeParse({ outcome: "unknown" }).success).toBe(false);
  });

  it("keeps the five-minute TTL the field list fixes", () => {
    expect(CONSENT_ATTEMPT_TTL_SECONDS).toBe(300);
  });
});
