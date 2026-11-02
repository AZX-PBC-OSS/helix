import { describe, expect, test } from "vitest";

import { describeDsn } from "./dsn.js";

/**
 * The store description every jobs log line and the boot line go through —
 * the credential-redaction seam the no-secrets-in-logs rule rides on. The
 * caller sites (the supervisor's four log events, the boot line, the
 * migration command's events) all share this one function, so pinning it here
 * pins all of them: identity, host, port and database in, password never out —
 * not even decoded out of its URL-escaped form.
 */
describe("describeDsn", () => {
  test("carries identity, host, port and database — never the password", () => {
    expect(describeDsn("postgresql://helix_jobs:sekret@db.example:5432/helix_jobs")).toBe(
      "helix_jobs@db.example:5432/helix_jobs",
    );
  });

  test("a URL-escaped password never leaks, raw or decoded", () => {
    const described = describeDsn("postgresql://helix_jobs:p%40ss%2Fw%3Ard@db:5432/helix_jobs");
    expect(described).toBe("helix_jobs@db:5432/helix_jobs");
    for (const leak of ["p%40ss", "p@ss", "w:rd", "sekret"]) {
      expect(described).not.toContain(leak);
    }
  });

  test("a DSN without a password still describes the store", () => {
    expect(describeDsn("postgresql://helix_jobs@db:5432/helix_jobs")).toBe(
      "helix_jobs@db:5432/helix_jobs",
    );
  });

  test("an unparseable DSN degrades to a marker, never a throw into the log path", () => {
    expect(describeDsn("not a dsn")).toBe("<unparseable dsn>");
  });
});
