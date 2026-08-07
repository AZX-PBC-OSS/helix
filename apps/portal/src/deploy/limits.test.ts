import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  assertBundleLimits,
  resolveMaxFileBytes,
  resolveMaxTotalBytes,
} from "./limits.js";

const MB = 1024 * 1024;

describe("deploy size limits", () => {
  it("defaults to 50 MB per file and 250 MB per bundle", () => {
    expect(resolveMaxFileBytes({})).toBe(50 * MB);
    expect(resolveMaxTotalBytes({})).toBe(250 * MB);
    expect(DEFAULT_MAX_FILE_BYTES).toBe(50 * MB);
    expect(DEFAULT_MAX_TOTAL_BYTES).toBe(250 * MB);
  });

  it("reads megabyte overrides from the env", () => {
    expect(resolveMaxFileBytes({ DEPLOY_MAX_FILE_MB: "120" })).toBe(120 * MB);
    expect(resolveMaxTotalBytes({ DEPLOY_MAX_BUNDLE_MB: " 500 " })).toBe(500 * MB);
    expect(resolveMaxFileBytes({ DEPLOY_MAX_FILE_MB: "1.5" })).toBe(Math.floor(1.5 * MB));
  });

  it("treats unset and empty as 'use the default'", () => {
    expect(resolveMaxFileBytes({ DEPLOY_MAX_FILE_MB: "" })).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(resolveMaxTotalBytes({ DEPLOY_MAX_BUNDLE_MB: "   " })).toBe(DEFAULT_MAX_TOTAL_BYTES);
  });

  // A cap that silently reverts to the default on a typo is worse than a boot
  // failure — an operator who set "0" or "50MB" would never learn it was ignored.
  it.each(["0", "-1", "50MB", "lots", "NaN", "Infinity"])(
    "refuses the unusable override %j",
    (value) => {
      expect(() => resolveMaxFileBytes({ DEPLOY_MAX_FILE_MB: value })).toThrow(
        /DEPLOY_MAX_FILE_MB/,
      );
      expect(() => resolveMaxTotalBytes({ DEPLOY_MAX_BUNDLE_MB: value })).toThrow(
        /DEPLOY_MAX_BUNDLE_MB/,
      );
    },
  );

  it("assertBundleLimits checks both, so a bad value fails the boot", () => {
    expect(() => assertBundleLimits({ DEPLOY_MAX_FILE_MB: "50" })).not.toThrow();
    expect(() => assertBundleLimits({ DEPLOY_MAX_BUNDLE_MB: "nope" })).toThrow(
      /DEPLOY_MAX_BUNDLE_MB/,
    );
  });
});
