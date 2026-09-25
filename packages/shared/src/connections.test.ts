import { describe, expect, it } from "vitest";

import {
  CONNECTION_STATUSES,
  ConnectionStatusSchema,
  PROVIDERS_CHANNEL,
  UserConnectionSchema,
  type UserConnection,
} from "./connections.js";

/** Dev-envelope-shaped sealed material — the row never carries plaintext. */
const SEALED_MATERIAL = "aesgcm:1a2b3c4d:5e6f7081:8292a3b4c5d6e7f8a9b0c1d2";

const BASE_ROW = {
  id: "7c1e9a4f-2b3d-4e5f-8a9b-0c1d2e3f4a5b",
  userOid: "00000000-0000-0000-0000-000000000001",
  providerId: "0b2f6f8e-4c1a-4d2e-9f3b-2a5c7e9b1d01",
  providerRevision: 3,
  env: "prod",
  status: "live",
  material: SEALED_MATERIAL,
  grantedScopes: ["default", "projects:read"],
  grantedAt: "2026-09-25T00:00:00.000Z",
  expiresAt: "2026-09-25T01:00:00.000Z",
  renewBeforeNext: false,
  pendingRetire: null,
  lastRenewedAt: null,
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
} satisfies UserConnection;

describe("UserConnectionSchema — the stored user_connections row (ADR-0006)", () => {
  it("parses a representative row of every status", () => {
    for (const status of CONNECTION_STATUSES) {
      const parsed = UserConnectionSchema.parse({ ...BASE_ROW, status });
      expect(parsed.status).toBe(status);
    }
  });

  it("carries the retired-row shape: tombstone fields populated", () => {
    // An invalidated row mid-retirement: the old sealed reference is still in
    // the ledger (the sweep has not claimed it yet) and renewal has happened
    // before. Everything must round-trip.
    const retired: UserConnection = {
      ...BASE_ROW,
      status: "invalidated",
      lastRenewedAt: "2026-09-25T00:30:00.000Z",
      pendingRetire: SEALED_MATERIAL,
      renewBeforeNext: true,
    };
    expect(UserConnectionSchema.parse(retired)).toEqual(retired);
  });

  it("rejects an unknown status value — bounded vocabulary, fail closed", () => {
    expect(ConnectionStatusSchema.safeParse("connected").success).toBe(false);
    expect(UserConnectionSchema.safeParse({ ...BASE_ROW, status: "connected" }).success).toBe(
      false,
    );
    // Case is not normalized away either — the vocabulary is exact.
    expect(UserConnectionSchema.safeParse({ ...BASE_ROW, status: "Live" }).success).toBe(false);
  });

  it("rejects unknown keys — a strict stored-row parse, like the provider row", () => {
    expect(
      UserConnectionSchema.safeParse({ ...BASE_ROW, status: "live", plaintextToken: "x" }).success,
    ).toBe(false);
  });

  it("rejects rows missing the ledger or expiry fields — no partial row parses", () => {
    const withoutLedger: Record<string, unknown> = { ...BASE_ROW };
    delete withoutLedger.pendingRetire;
    expect(UserConnectionSchema.safeParse(withoutLedger).success).toBe(false);
    const withoutExpiry: Record<string, unknown> = { ...BASE_ROW };
    delete withoutExpiry.expiresAt;
    expect(UserConnectionSchema.safeParse(withoutExpiry).success).toBe(false);
  });

  it("rejects empty sealed material and an empty granted-scope entry", () => {
    expect(UserConnectionSchema.safeParse({ ...BASE_ROW, material: "" }).success).toBe(false);
    expect(UserConnectionSchema.safeParse({ ...BASE_ROW, grantedScopes: [""] }).success).toBe(
      false,
    );
  });
});

describe("PROVIDERS_CHANNEL — the ADR-0011 NOTIFY channel name", () => {
  it("is pinned to the literal the migration embeds", () => {
    // migration 20260925065340_connection_substrate performs
    // pg_notify('helix_providers_changed', …) inside helix_providers_notify();
    // this constant is the single definition the egress listener imports.
    // Pinned here so a rename fails a test beside the migration, not silently
    // at runtime with a listener attached to a channel nothing pings.
    expect(PROVIDERS_CHANNEL).toBe("helix_providers_changed");
  });
});
