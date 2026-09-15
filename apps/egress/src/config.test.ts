import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

/**
 * The dev seams are the point of this file: both open a control ADR-0005 rests
 * on, on the plane that holds plaintext connection secrets, and neither one
 * changes any observable behaviour when it is wrongly set — so the boot-fail is
 * the only thing that surfaces it.
 */
const ENV = {
  HELIX_INSTRUCTION_SECRET: "0123456789abcdef0123456789abcdef",
  EGRESS_DATABASE_URL: "postgres://helix_egress:helix_egress@db:5432/helix",
};

describe("loadConfig", () => {
  it("defaults both dev seams off", () => {
    const config = loadConfig(ENV);
    expect(config.allowPrivate).toBe(false);
    expect(config.allowInsecureConnection).toBe(false);
  });

  it("opens the dev seams only on an exact 'true'", () => {
    const on = loadConfig({
      ...ENV,
      EGRESS_ALLOW_PRIVATE: "true",
      EGRESS_ALLOW_INSECURE_CONNECTION: "true",
    });
    expect(on.allowPrivate).toBe(true);
    expect(on.allowInsecureConnection).toBe(true);

    // "Allow" polarity, default off — anything truthy-but-not-"true" stays shut.
    const fuzzy = loadConfig({
      ...ENV,
      EGRESS_ALLOW_PRIVATE: "1",
      EGRESS_ALLOW_INSECURE_CONNECTION: "yes",
    });
    expect(fuzzy.allowPrivate).toBe(false);
    expect(fuzzy.allowInsecureConnection).toBe(false);
  });

  it("refuses EGRESS_ALLOW_PRIVATE in production", () => {
    expect(() =>
      loadConfig({ ...ENV, EGRESS_ALLOW_PRIVATE: "true", NODE_ENV: "production" }),
    ).toThrow(/EGRESS_ALLOW_PRIVATE.*refused in production/);
  });

  it("refuses EGRESS_ALLOW_INSECURE_CONNECTION in production", () => {
    expect(() =>
      loadConfig({ ...ENV, EGRESS_ALLOW_INSECURE_CONNECTION: "true", NODE_ENV: "production" }),
    ).toThrow(/EGRESS_ALLOW_INSECURE_CONNECTION.*refused in production/);
  });

  it("boots in production with both unset", () => {
    const config = loadConfig({ ...ENV, NODE_ENV: "production" });
    expect(config.allowPrivate).toBe(false);
    expect(config.allowInsecureConnection).toBe(false);
  });

  it("throws a clear error on missing requirements", () => {
    expect(() => loadConfig({})).toThrow(/HELIX_INSTRUCTION_SECRET is required/);
    expect(() => loadConfig({ HELIX_INSTRUCTION_SECRET: "short" })).toThrow(/at least 32 bytes/);
    expect(() => loadConfig({ HELIX_INSTRUCTION_SECRET: ENV.HELIX_INSTRUCTION_SECRET })).toThrow(
      /EGRESS_DATABASE_URL or DATABASE_URL is required/,
    );
  });

  // ADR-0046 — the keyless list is empty by default (resolution stays DB-only)
  // and malformed entries are boot errors, never silently dropped rules.
  describe("EGRESS_MANAGED_IDENTITY_CONNECTIONS", () => {
    it("defaults to no managed-identity connections", () => {
      expect(loadConfig(ENV).managedIdentityConnections).toEqual([]);
      expect(
        loadConfig({ ...ENV, EGRESS_MANAGED_IDENTITY_CONNECTIONS: "  " })
          .managedIdentityConnections,
      ).toEqual([]);
    });

    it("parses name=host-suffix pairs, lowercasing the suffix", () => {
      const config = loadConfig({
        ...ENV,
        EGRESS_MANAGED_IDENTITY_CONNECTIONS:
          "foundry=Services.AI.Azure.com, contoso=contoso.openai.azure.com",
      });
      expect(config.managedIdentityConnections).toEqual([
        { connection: "foundry", hostSuffix: "services.ai.azure.com" },
        { connection: "contoso", hostSuffix: "contoso.openai.azure.com" },
      ]);
    });

    it.each([
      ["foundry", "missing the =host-suffix half"],
      ["foundry=", "empty suffix"],
      ["foundry=.services.ai.azure.com", "leading-dot suffix"],
      ["foundry=com", "bare TLD — would match the world"],
      ["foundry=https://services.ai.azure.com", "a URL, not a host suffix"],
      ["Foundry=services.ai.azure.com", "a non-kebab connection name"],
      ["foundry=services.ai.azure.com,foundry=openai.azure.com", "a duplicate connection"],
    ])("refuses malformed entry %s (%s)", (value) => {
      expect(() => loadConfig({ ...ENV, EGRESS_MANAGED_IDENTITY_CONNECTIONS: value })).toThrow(
        /EGRESS_MANAGED_IDENTITY_CONNECTIONS/,
      );
    });
  });
});
