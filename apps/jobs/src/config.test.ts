import { describe, expect, test } from "vitest";

import { deriveJobsInstructionKey } from "@azx-pbc/shared/jobsSigning";

import { DEFAULT_JOBS_STATEMENT_TIMEOUT_MS, loadJobsConfig } from "./config.js";

/**
 * The boot configuration's contract: an explicit startup error for every
 * invalid or missing key — the earliest stage that can catch a bad value —
 * and no invented defaults for credentials (design §8: "Parse-invalid config
 * and missing keys are boot errors").
 */

const ROOT_EDGE = "uFEfLTTVeHJK0+P/dQEWv8ccOyFrkZw7InR0I52V4/0=";
const ROOT_PORTAL = "jUwQKa33JNljh0jULeithrh3JOL8dUmxPJknzGCjQBA=";

const VALID = {
  JOBS_SERVER_ID: "jobs",
  JOBS_DATABASE_URL: "postgresql://helix_jobs:pw@db:5432/helix_jobs",
  JOBS_EDGE_TO_JOBS_SECRET: ROOT_EDGE,
  JOBS_PORTAL_TO_JOBS_SECRET: ROOT_PORTAL,
};

describe("loadJobsConfig", () => {
  test("resolves the required identity, store and receiver keys", () => {
    const config = loadJobsConfig({ ...VALID });
    expect(config.serverId).toBe("jobs");
    expect(config.databaseUrl).toBe("postgresql://helix_jobs:pw@db:5432/helix_jobs");
    expect(config.statementTimeoutMs).toBe(DEFAULT_JOBS_STATEMENT_TIMEOUT_MS);
    // The roots derive to the direction keys the receiver verifies with —
    // HKDF over each root, domain-separated.
    expect(config.edgeToJobsKey).toEqual(deriveJobsInstructionKey(ROOT_EDGE, "edgeToJobs"));
    expect(config.portalToJobsKey).toEqual(deriveJobsInstructionKey(ROOT_PORTAL, "portalToJobs"));
  });

  test("the statement-timeout override is honored when positive", () => {
    expect(loadJobsConfig({ ...VALID, JOBS_STATEMENT_TIMEOUT_MS: "2500" }).statementTimeoutMs).toBe(
      2500,
    );
  });

  test("a whitespace-only statement timeout falls back to the default, not an error", () => {
    // Env files routinely carry blank values: an unset knob, not a bad one —
    // the same branch an absent key takes.
    expect(loadJobsConfig({ ...VALID, JOBS_STATEMENT_TIMEOUT_MS: "   " }).statementTimeoutMs).toBe(
      DEFAULT_JOBS_STATEMENT_TIMEOUT_MS,
    );
  });

  test("a missing JOBS_SERVER_ID fails with the key named", () => {
    const rest = { ...VALID } as Record<string, string>;
    delete rest.JOBS_SERVER_ID;
    expect(() => loadJobsConfig(rest)).toThrow(/JOBS_SERVER_ID is required/);
  });

  test("a malformed server id fails explicitly, with the key named", () => {
    expect(() => loadJobsConfig({ ...VALID, JOBS_SERVER_ID: "Not A Server" })).toThrow(
      /JOBS_SERVER_ID/,
    );
  });

  test("a missing JOBS_DATABASE_URL fails with the key named", () => {
    const rest = { ...VALID } as Record<string, string>;
    delete rest.JOBS_DATABASE_URL;
    expect(() => loadJobsConfig(rest)).toThrow(/JOBS_DATABASE_URL is required/);
  });

  test("a non-postgres store DSN fails explicitly", () => {
    expect(() =>
      loadJobsConfig({ ...VALID, JOBS_DATABASE_URL: "mysql://root@db:3306/jobs" }),
    ).toThrow(/JOBS_DATABASE_URL must be a postgres/);
  });

  test("a garbage DSN fails explicitly", () => {
    expect(() => loadJobsConfig({ ...VALID, JOBS_DATABASE_URL: "not a url" })).toThrow(
      /JOBS_DATABASE_URL must be a postgres/,
    );
  });

  test("a missing signing root fails with its env key named, for each receiving direction", () => {
    for (const key of ["JOBS_EDGE_TO_JOBS_SECRET", "JOBS_PORTAL_TO_JOBS_SECRET"] as const) {
      const rest = { ...VALID } as Record<string, string>;
      delete rest[key];
      expect(() => loadJobsConfig(rest), key).toThrow(new RegExp(`${key} is required`));
    }
  });

  test("a signing root that is not a base64 32-byte secret fails at boot, with the key named", () => {
    // A root that derives nothing usable must stop the boot, not wait for a
    // first instruction to fail verification.
    expect(() => loadJobsConfig({ ...VALID, JOBS_EDGE_TO_JOBS_SECRET: "too-short" })).toThrow(
      /JOBS_EDGE_TO_JOBS_SECRET must be a base64-encoded 32-byte root secret/,
    );
    expect(() => loadJobsConfig({ ...VALID, JOBS_PORTAL_TO_JOBS_SECRET: "not base64!!!" })).toThrow(
      /JOBS_PORTAL_TO_JOBS_SECRET must be a base64-encoded 32-byte root secret/,
    );
  });

  test("a non-positive or non-finite statement timeout is a boot error, not a silent no-op", () => {
    for (const raw of ["0", "-5", "abc", "Infinity"]) {
      expect(() => loadJobsConfig({ ...VALID, JOBS_STATEMENT_TIMEOUT_MS: raw })).toThrow(
        /JOBS_STATEMENT_TIMEOUT_MS must be a positive number of milliseconds/,
      );
    }
  });

  test("a whitespace-padded value is trimmed, not refused", () => {
    const config = loadJobsConfig({
      ...VALID,
      JOBS_SERVER_ID: "  jobs  ",
      JOBS_DATABASE_URL: "  postgresql://helix_jobs:pw@db:5432/helix_jobs  ",
    });
    expect(config.serverId).toBe("jobs");
  });

  test("the jobs→edge minting root is not parsed — the receiver requires its two verification roots only", () => {
    // The minting half for this service's own callbacks has no reader until
    // the worker tickets consume it; requiring it would fail the boot on a
    // credential nothing reads. Even a garbage value must not stop the boot.
    const config = loadJobsConfig({ ...VALID, JOBS_JOBS_TO_EDGE_SECRET: "not a root" });
    expect(config.serverId).toBe("jobs");
  });
});
