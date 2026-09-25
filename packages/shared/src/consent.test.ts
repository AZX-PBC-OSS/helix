import { describe, expect, it } from "vitest";
import {
  CancelRequestSchema,
  CancelResponseSchema,
  ConnectOutcomeMessageSchema,
  ConsultRequestSchema,
  ConsultResponseSchema,
  CONSENT_ATTEMPT_TTL_SECONDS,
  CONSENT_MESSAGE_OUTCOMES,
  CONSENT_MESSAGE_REASONS,
  CONNECT_MESSAGE_VERSION,
  HELIX_CONNECT_MESSAGE_SOURCE,
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

describe("ConnectOutcomeMessageSchema (T-0014 — design.md §Completion message)", () => {
  const base = { provider: "asana", outcome: "connected", reason: null };

  it("accepts the design's exact shape: source, version, attempt, provider, outcome, reason", () => {
    const msg = ConnectOutcomeMessageSchema.parse({
      source: HELIX_CONNECT_MESSAGE_SOURCE,
      version: CONNECT_MESSAGE_VERSION,
      attempt: "corr-tag-1",
      ...base,
    });
    expect(msg).toEqual({
      source: "helix-connect",
      version: 1,
      attempt: "corr-tag-1",
      provider: "asana",
      outcome: "connected",
      reason: null,
    });
  });

  it("the attempt tag is optional — a raw entry without ?attempt posts none", () => {
    const msg = ConnectOutcomeMessageSchema.parse({ ...base, source: "helix-connect", version: 1 });
    expect(msg.attempt).toBeUndefined();
  });

  it("is strict and version-pinned — producer skew fails closed at the receiver", () => {
    expect(
      ConnectOutcomeMessageSchema.safeParse({
        ...base,
        source: "helix-connect",
        version: 1,
        extra: "smuggled",
      }).success,
    ).toBe(false);
    expect(
      ConnectOutcomeMessageSchema.safeParse({ ...base, source: "helix-connect", version: 2 })
        .success,
    ).toBe(false);
    expect(
      ConnectOutcomeMessageSchema.safeParse({ ...base, source: "someone-else", version: 1 })
        .success,
    ).toBe(false);
  });

  it("carries reason only with the error outcome", () => {
    expect(
      ConnectOutcomeMessageSchema.safeParse({
        source: "helix-connect",
        version: 1,
        provider: "asana",
        outcome: "error",
        reason: "service_unavailable",
      }).success,
    ).toBe(true);
    expect(
      ConnectOutcomeMessageSchema.safeParse({
        source: "helix-connect",
        version: 1,
        provider: "asana",
        outcome: "connected",
        reason: "conflict",
      }).success,
    ).toBe(false);
    expect(
      ConnectOutcomeMessageSchema.safeParse({
        source: "helix-connect",
        version: 1,
        provider: "asana",
        outcome: "connected",
      }).success,
    ).toBe(false);
  });

  it("bounds the outcome and reason vocabularies to the helper contract", () => {
    expect(CONSENT_MESSAGE_OUTCOMES).toEqual([
      "connected",
      "already_connected",
      "denied",
      "cancelled",
      "timeout",
      "blocked",
      "signin_required",
      "error",
    ]);
    expect(CONSENT_MESSAGE_REASONS).toEqual([
      "conflict",
      "provider_unavailable",
      "provider_misconfigured",
      "provider_incompatible",
      "service_unavailable",
    ]);
    for (const outcome of CONSENT_MESSAGE_OUTCOMES) {
      expect(
        ConnectOutcomeMessageSchema.safeParse({
          source: "helix-connect",
          version: 1,
          provider: "asana",
          outcome,
          reason: null,
        }).success,
      ).toBe(true);
    }
    expect(
      ConnectOutcomeMessageSchema.safeParse({
        source: "helix-connect",
        version: 1,
        provider: "asana",
        outcome: "something-else",
        reason: null,
      }).success,
    ).toBe(false);
  });

  it("the attempt tag is URL-safe punctuation, bounded", () => {
    expect(
      ConnectOutcomeMessageSchema.safeParse({
        source: "helix-connect",
        version: 1,
        attempt: "abc-123._~",
        ...base,
      }).success,
    ).toBe(true);
    expect(
      ConnectOutcomeMessageSchema.safeParse({
        source: "helix-connect",
        version: 1,
        attempt: "not safe</script>",
        ...base,
      }).success,
    ).toBe(false);
    expect(
      ConnectOutcomeMessageSchema.safeParse({
        source: "helix-connect",
        version: 1,
        attempt: "x".repeat(129),
        ...base,
      }).success,
    ).toBe(false);
  });
});
