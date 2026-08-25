import fp from "fastify-plugin";
import { UnavailableDirectory, type DirectoryProvider } from "@azx-pbc/directory";
import { createDirectoryFromEnv } from "../directory/custody.js";
import { directorySearchPolicy } from "../policy/directoryPolicy.js";
import { SEARCH_WINDOW_MS, sweepSearchLimits } from "../directory/rateLimit.js";

export interface DirectoryPluginOptions {
  /** Inject a provider (tests). When omitted, one is built from the environment. */
  provider?: DirectoryProvider;
}

/**
 * Decorates the portal with the directory provider (ADR-0040 decision 3) — group
 * search and id→name resolution for the Access tab's group picker.
 *
 * **The decorator is never null**, unlike `secretStore`. That is deliberate: a
 * nullable provider pushes a null check into every call site, and the one that
 * gets forgotten is a 500 on the Access tab — exactly the failure decision 8
 * forbids ("must not surface as a broken Access tab, and must not be silent").
 * An {@link UnavailableDirectory} reports its own absence as a value instead, so
 * the degraded path is the same code path as the happy one.
 *
 * A construction failure is therefore also non-fatal, and logged: silently
 * degrading to "directory unavailable" would be indistinguishable from never
 * having configured one.
 */
export const directoryPlugin = fp<DirectoryPluginOptions>(
  async (app, opts) => {
    app.decorate("directory", opts.provider ?? buildFromEnv(app.log));

    /**
     * GC elapsed `portal_rate_counters` windows.
     *
     * `sweepSearchLimits` existed with no caller at all for a while, which made
     * its own doc comment ("so a flood can't grow the table without bound") an
     * assertion about a bound that did not exist, and left the migration's
     * `resetAt` index and `DELETE` grant as dead weight. The row count was in fact
     * bounded by the population of portal principals — small, but not what the
     * comment claimed, and not something a future high-cardinality bucket prefix
     * would keep true.
     *
     * Shape copied from the edge's `rate_counters` sweeper
     * (`apps/edge/src/server.ts`): `unref` so it never holds the process open,
     * cleared on close so the many apps a test run builds do not leak timers.
     * Homed here rather than in `server.ts` so `buildApp()`/`close()` exercise the
     * disposal.
     */
    const sweep = setInterval(() => {
      void sweepSearchLimits(app.prisma).catch((err: unknown) => {
        app.log.warn({ err }, "portal_rate_counters sweep failed");
      });
    }, SEARCH_WINDOW_MS);
    sweep.unref();
    app.addHook("onClose", async () => {
      clearInterval(sweep);
    });
  },
  { name: "directory" },
);

interface PluginLog {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/**
 * Build from the environment and **say which backend won, every time.**
 *
 * That log line is not decoration. Group names are not stored anywhere, so the
 * only evidence of which directory answered a search is the answer itself — and
 * a fixture-backed picker looks exactly like a working one, just with different
 * groups in it. Without this line, "my tenant's groups aren't showing up" is
 * indistinguishable from "that group doesn't exist" and from "the Graph grant is
 * missing", and the first thing anyone reaches for is the Entra config, which is
 * the one thing that is fine.
 *
 * Fixtures log at `warn`, not `info`: on a developer machine pointed at a real
 * tenant for auth — which is a normal setup — fixtures are almost certainly not
 * what was wanted.
 *
 * The **search tier** rides the same line (ADR-0040 decision 11). Same argument
 * one axis over: a caller who may not search sees a picker with no search box,
 * which looks identical to a directory that has nothing to say, and the tier is
 * the only thing that distinguishes them. An unrecognised value additionally
 * warns on its own line, because it means an operator tried to set a posture and
 * got a different one.
 */
function buildFromEnv(log: PluginLog): DirectoryProvider {
  const search = directorySearchPolicy();
  if (search.invalid !== undefined) {
    log.warn(
      { value: search.invalid, tier: search.tier },
      `PORTAL_DIRECTORY_SEARCH="${search.invalid}" is not one of everyone|admins|none — ` +
        `falling back to "${search.tier}"`,
    );
  }
  try {
    const { provider, detail } = createDirectoryFromEnv();
    const fixtures = detail.startsWith("dev fixtures");
    const line = `directory provider: ${detail}; search: ${search.tier}`;
    if (fixtures) log.warn({ backend: "fixtures", search: search.tier }, line);
    else log.info({ backend: provider.constructor.name, search: search.tier }, line);
    return provider;
  } catch (err) {
    log.error(
      { err },
      "directory provider is configured but could not be built — group search will report " +
        "itself unavailable and the Access tab will fall back to free-text group ids",
    );
    return new UnavailableDirectory("the directory provider failed to initialise");
  }
}
