import { describe, expect, it } from "vitest";
import { EntraDirectory, StaticDirectory, UnavailableDirectory } from "@azx-pbc/directory";
import { createDirectoryFromEnv } from "./custody.js";

/**
 * The single decision point for which directory this deployment answers group
 * searches from, so the assertions are about the inversions rather than the happy
 * path — the same posture as `secrets/custody.test.ts`.
 *
 * Everything runs against an injected `env`, never `process.env`.
 */
const pick = (env: NodeJS.ProcessEnv) => createDirectoryFromEnv(env);

describe("createDirectoryFromEnv — explicit selector", () => {
  /**
   * The regression that motivated `PORTAL_DIRECTORY`. Auto-detection keys on
   * `AZURE_CLIENT_ID`, which only Container Apps sets — so a developer who had
   * pointed the portal at real Entra for *auth* (via `apps/portal/.env.local`)
   * still silently got fixture groups for *search*. Searching their real tenant
   * returned nothing and searching "eng" returned convincing fakes, with no
   * error, no banner and no log line to explain it.
   */
  it("selects Microsoft Graph on a dev machine, where AZURE_CLIENT_ID never exists", () => {
    const { provider, detail } = pick({ PORTAL_DIRECTORY: "entra" });
    expect(provider).toBeInstanceOf(EntraDirectory);
    expect(detail).toMatch(/Graph/);
  });

  it("selects fixtures only when asked, and says they are not real", () => {
    const { provider, detail } = pick({ PORTAL_DIRECTORY: "fixtures" });
    expect(provider).toBeInstanceOf(StaticDirectory);
    expect(detail).toMatch(/NOT your real directory/);
  });

  it("can be turned off outright", () => {
    const { provider } = pick({ PORTAL_DIRECTORY: "off" });
    expect(provider).toBeInstanceOf(UnavailableDirectory);
  });

  it("wins over auto-detection in both directions", () => {
    // Explicit fixtures beats a present managed identity…
    expect(pick({ PORTAL_DIRECTORY: "fixtures", AZURE_CLIENT_ID: "mi" }).provider).toBeInstanceOf(
      StaticDirectory,
    );
    // …and explicit entra beats its absence.
    expect(pick({ PORTAL_DIRECTORY: "entra" }).provider).toBeInstanceOf(EntraDirectory);
  });

  // A typo must not land on fixtures, which is the one wrong answer that looks
  // like a right one.
  it("refuses an unrecognised value rather than falling back to fixtures", () => {
    const { provider, detail } = pick({ PORTAL_DIRECTORY: "Entra " });
    expect(provider).toBeInstanceOf(UnavailableDirectory);
    expect(detail).toMatch(/not one of entra\|fixtures\|off/);
  });

  it("refuses explicitly-requested fixtures in production", () => {
    const { provider, detail } = pick({ PORTAL_DIRECTORY: "fixtures", NODE_ENV: "production" });
    expect(provider).toBeInstanceOf(UnavailableDirectory);
    expect(detail).toMatch(/refused in production/);
  });
});

describe("createDirectoryFromEnv — auto-detection fallback", () => {
  it("uses the managed identity when one is present", () => {
    expect(pick({ AZURE_CLIENT_ID: "mi-guid" }).provider).toBeInstanceOf(EntraDirectory);
  });

  it("uses fixtures outside production, and says how to switch", () => {
    const { provider, detail } = pick({});
    expect(provider).toBeInstanceOf(StaticDirectory);
    // The message has to carry the fix, because this is the state someone hits
    // while wondering why their real groups are missing.
    expect(detail).toMatch(/PORTAL_DIRECTORY=entra/);
    expect(detail).toMatch(/az login/);
  });

  /**
   * The inversion that matters most: a prod portal must never answer a group
   * search from a hardcoded list. It would show an operator groups that do not
   * exist in their tenant, and an app scoped to one of those ids denies everyone
   * — which reads as a platform bug, not a config one.
   */
  it("refuses fixtures in production, degrading to unavailable instead", () => {
    const { provider } = pick({ NODE_ENV: "production" });
    expect(provider).toBeInstanceOf(UnavailableDirectory);
    expect(provider).not.toBeInstanceOf(StaticDirectory);
  });

  it("prefers the real directory over fixtures in every environment", () => {
    for (const NODE_ENV of ["development", "test", "production"]) {
      expect(pick({ AZURE_CLIENT_ID: "mi-guid", NODE_ENV }).provider).toBeInstanceOf(
        EntraDirectory,
      );
    }
  });
});

describe("every branch reports what it chose", () => {
  // The boot log is the only evidence of which backend answered — group names are
  // stored nowhere, so a fixture-backed picker is indistinguishable from a working
  // one. An empty or vague detail string defeats the whole point.
  it("returns a non-empty detail for every configuration", () => {
    const envs: NodeJS.ProcessEnv[] = [
      {},
      { NODE_ENV: "production" },
      { AZURE_CLIENT_ID: "mi" },
      { PORTAL_DIRECTORY: "entra" },
      { PORTAL_DIRECTORY: "fixtures" },
      { PORTAL_DIRECTORY: "off" },
      { PORTAL_DIRECTORY: "nonsense" },
      { PORTAL_DIRECTORY: "fixtures", NODE_ENV: "production" },
    ];
    for (const env of envs) {
      const { detail } = pick(env);
      expect(detail.length).toBeGreaterThan(10);
    }
  });

  // Degrading reports rather than throws, so no route needs a try/catch to avoid
  // 500ing the Access tab (ADR-0040 decision 8).
  it("degrades by reporting, never by throwing", async () => {
    const { provider } = pick({ NODE_ENV: "production" });
    await expect(provider.searchGroups("eng", 10)).resolves.toMatchObject({ available: false });
    await expect(provider.getGroups(["x"])).resolves.toMatchObject({ available: false });
  });
});
