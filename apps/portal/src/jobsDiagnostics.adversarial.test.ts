import { describe, expect, it } from "vitest";
import {
  CapabilitiesSchema,
  JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
  JOBS_FETCH_QUALIFIED_TYPE,
} from "@azx-pbc/shared";
import { assertNoUnavailableJobTypeAdds } from "./approvals/service.js";
import {
  assertDeploymentConfig,
  resolveAdvertisedJobTypes,
  resolveJobsCatalogueServers,
} from "./deployment.js";
import { withEnv } from "./test/env.js";

/**
 * The diagnostic job type's production refusals, at the portal: a production
 * catalogue cannot parse, a guessed name cannot parse in any mode, the
 * approval write-gate refuses the add in production, and no client-supplied
 * enable control is representable in a manifest. The non-production happy
 * paths live in `deployment.test.ts` and `routes/catalogue.test.ts`.
 */

const DIAGNOSTIC_CATALOGUE = JSON.stringify({
  servers: {
    jobs: { state: "serving", types: [JOBS_FETCH_QUALIFIED_TYPE, JOBS_DIAGNOSTIC_QUALIFIED_TYPE] },
  },
});

/** The production boot env, valid apart from the catalogue under test. */
const PROD_ENV = {
  NODE_ENV: "production",
  APP_PUBLIC_BASE: "https://azx.helix.azxlabs.io",
};

describe("a production portal refuses the diagnostic type at the catalogue source", () => {
  it("the catalogue listing jobs:diagnostic fails the resolver and the boot", () => {
    expect(() =>
      resolveJobsCatalogueServers({ ...PROD_ENV, PORTAL_JOBS_CATALOGUE: DIAGNOSTIC_CATALOGUE }),
    ).toThrow(/PORTAL_JOBS_CATALOGUE is not a valid jobs catalogue source/);
    expect(() =>
      assertDeploymentConfig({ ...PROD_ENV, PORTAL_JOBS_CATALOGUE: DIAGNOSTIC_CATALOGUE }),
    ).toThrow(/PORTAL_JOBS_CATALOGUE is not a valid jobs catalogue source/);
  });

  it("guessed type names fail the parse in production and out of it", () => {
    for (const guessed of ["jobs:synthetic", "jobs:diagnostics"]) {
      const source = JSON.stringify({
        servers: { jobs: { state: "serving", types: [guessed] } },
      });
      expect(() =>
        resolveJobsCatalogueServers({ NODE_ENV: "production", PORTAL_JOBS_CATALOGUE: source }),
      ).toThrow(/PORTAL_JOBS_CATALOGUE/);
      expect(() =>
        resolveJobsCatalogueServers({ NODE_ENV: "test", PORTAL_JOBS_CATALOGUE: source }),
      ).toThrow(/PORTAL_JOBS_CATALOGUE/);
    }
  });
});

describe("the approval write-gate refuses a diagnostic add in production", () => {
  it("validation_failed when the catalogue installs fetch only", async () => {
    await withEnv(
      {
        NODE_ENV: "production",
        PORTAL_JOBS_CATALOGUE: JSON.stringify({
          servers: { jobs: { state: "serving", types: [JOBS_FETCH_QUALIFIED_TYPE] } },
        }),
      },
      async () => {
        try {
          assertNoUnavailableJobTypeAdds(
            { jobs: { types: [JOBS_FETCH_QUALIFIED_TYPE] } },
            { jobs: { types: [JOBS_FETCH_QUALIFIED_TYPE, JOBS_DIAGNOSTIC_QUALIFIED_TYPE] } },
          );
          expect.unreachable("the production gate must refuse the diagnostic add");
        } catch (err) {
          expect((err as { code?: string }).code).toBe("validation_failed");
          expect((err as Error).message).toContain(JOBS_DIAGNOSTIC_QUALIFIED_TYPE);
        }
      },
    );
  });

  it("refused when only fetch is advertised (the fully disabled installation too)", async () => {
    await withEnv({ NODE_ENV: "production", PORTAL_JOBS_CATALOGUE: undefined }, async () => {
      expect(() =>
        assertNoUnavailableJobTypeAdds({}, { jobs: { types: [JOBS_DIAGNOSTIC_QUALIFIED_TYPE] } }),
      ).toThrow(/not available on this deployment/);
    });
  });

  it("never passes while the catalogue env would list it — the production parse owns that refusal", async () => {
    await withEnv(
      { NODE_ENV: "production", PORTAL_JOBS_CATALOGUE: DIAGNOSTIC_CATALOGUE },
      async () => {
        expect(() =>
          assertNoUnavailableJobTypeAdds({}, { jobs: { types: [JOBS_DIAGNOSTIC_QUALIFIED_TYPE] } }),
        ).toThrow(/PORTAL_JOBS_CATALOGUE/);
      },
    );
  });

  it("the add passes on a non-production stack that lists it", async () => {
    await withEnv({ NODE_ENV: "test", PORTAL_JOBS_CATALOGUE: DIAGNOSTIC_CATALOGUE }, async () => {
      expect(resolveAdvertisedJobTypes().map((entry) => entry.id)).toContain(
        JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
      );
      expect(() =>
        assertNoUnavailableJobTypeAdds({}, { jobs: { types: [JOBS_DIAGNOSTIC_QUALIFIED_TYPE] } }),
      ).not.toThrow();
    });
  });
});

describe("no client-supplied diagnostics enable control is representable", () => {
  it("the jobs capability is strict: an enable flag next to the types is refused", () => {
    expect(
      CapabilitiesSchema.safeParse({
        jobs: { types: [JOBS_DIAGNOSTIC_QUALIFIED_TYPE], diagnostics: true },
      }).success,
    ).toBe(false);
    expect(
      CapabilitiesSchema.safeParse({ jobs: { types: [], enableDiagnostics: true } }).success,
    ).toBe(false);
  });
});
