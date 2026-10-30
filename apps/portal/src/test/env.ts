/**
 * Env overrides for tests. The portal's config resolvers (`deployment.ts`,
 * `deploy/limits.ts`) read `process.env` per call rather than freezing it at
 * boot, so a test can change a value around one inject instead of rebuilding
 * the app — this restores whatever was there before, including "unset".
 */
import { JOBS_FETCH_QUALIFIED_TYPE } from "@azx-pbc/shared";

/**
 * A valid `PORTAL_JOBS_CATALOGUE` value: one serving `jobs` server installing
 * the production fetch type — the deployment the jobs catalogue and grant
 * tests run against. Serialized through the same shape the resolver parses,
 * so a schema drift fails these tests instead of silently unconfiguring them.
 */
export const SERVING_JOBS_CATALOGUE = JSON.stringify({
  servers: { jobs: { state: "serving", types: [JOBS_FETCH_QUALIFIED_TYPE] } },
});

/** Run `fn` with env overrides applied, restoring the prior values after. */
export async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = new Map(Object.keys(overrides).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
