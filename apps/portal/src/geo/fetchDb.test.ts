import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { candidateMonths, looksLikeMmdb, parseArgs } from "./fetchDb.js";

describe("parseArgs", () => {
  it("defaults to this-month-or-last at the default path", () => {
    expect(parseArgs([], "/default.mmdb")).toEqual({ out: "/default.mmdb", month: null });
    expect(parseArgs(["--"], "/default.mmdb")).toEqual({ out: "/default.mmdb", month: null });
  });

  it("takes a pinned month and an output path in either order", () => {
    expect(parseArgs(["2026-09", "--out", "/x.mmdb"], "/d")).toEqual({
      out: "/x.mmdb",
      month: "2026-09",
    });
    expect(parseArgs(["--out", "/x.mmdb", "2026-09"], "/d")).toEqual({
      out: "/x.mmdb",
      month: "2026-09",
    });
  });

  it("never reads a month-shaped path as the month", () => {
    expect(parseArgs(["--out", "2026-09"], "/d")).toEqual({
      out: resolve("2026-09"),
      month: null,
    });
  });

  it.each([[["--out"]], [["--out", "--other"]], [["oops"]]])("rejects %j", (argv) => {
    expect(() => parseArgs(argv, "/d")).toThrow(/geo:fetch/);
  });
});

describe("candidateMonths", () => {
  it("is this month then last month, across a year boundary", () => {
    expect(candidateMonths(new Date("2026-01-03T00:00:00Z"))).toEqual(["2026-01", "2025-12"]);
  });
});

describe("looksLikeMmdb", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "geo-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const marker = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from("MaxMind.com")]);

  it("accepts a file ending in an MMDB metadata section", async () => {
    const path = join(dir, "ok.mmdb");
    await writeFile(path, Buffer.concat([Buffer.alloc(200_000, 1), marker, Buffer.alloc(300)]));
    expect(await looksLikeMmdb(path)).toBe(true);
  });

  it("rejects a truncated download that lost its metadata", async () => {
    const path = join(dir, "short.mmdb");
    await writeFile(path, Buffer.alloc(200_000, 1));
    expect(await looksLikeMmdb(path)).toBe(false);
  });
});
