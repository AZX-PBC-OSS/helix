import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./errors.js";

/** The structural P2002 check, against the shapes Prisma 7 actually produces. */

const adapterError = (fields: string[]) => ({
  code: "P2002",
  meta: {
    driverAdapterError: {
      cause: { kind: "UniqueConstraintViolation", constraint: { fields } },
    },
  },
});

describe("isUniqueViolation", () => {
  it("matches an unquoted adapter field", () => {
    expect(isUniqueViolation(adapterError(["number"]), "number")).toBe(true);
  });

  it("matches a camelCase field the adapter reports with identifier quotes", () => {
    expect(isUniqueViolation(adapterError(['"sourceTokenJti"']), "sourceTokenJti")).toBe(true);
    expect(isUniqueViolation(adapterError(['"sourceTokenJti"']), "number")).toBe(false);
  });

  it("matches a classic meta.target", () => {
    expect(isUniqueViolation({ code: "P2002", meta: { target: ["slug"] } }, "slug")).toBe(true);
  });

  it("is false for other errors", () => {
    expect(isUniqueViolation(new Error("x"), "slug")).toBe(false);
    expect(isUniqueViolation({ code: "P2025" }, "slug")).toBe(false);
  });
});
