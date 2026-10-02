import fp from "fastify-plugin";
import { createGeoResolverFromEnv, type GeoResolver } from "../geo/resolver.js";
import { sweepExpiredVisits, VISIT_SWEEP_INTERVAL_MS } from "../visits/retention.js";

export interface VisitorsPluginOptions {
  /** Inject a resolver (tests). When omitted, one is built from the environment. */
  geo?: GeoResolver;
}

/**
 * Decorates the portal with the visitor geo resolver and runs the `app_visits`
 * retention sweep (ADR-0050). The decorator is never null: an unconfigured
 * deployment gets an `UnavailableGeoResolver`, as `directory` does.
 *
 * The sweep is homed here rather than in `server.ts` so `buildApp()`/`close()`
 * exercise its disposal, the same as the `portal_rate_counters` sweep.
 */
export const visitorsPlugin = fp<VisitorsPluginOptions>(
  async (app, opts) => {
    app.decorate("geo", opts.geo ?? createGeoResolverFromEnv(app.log));

    const sweep = setInterval(() => {
      void sweepExpiredVisits(app.prisma).then(
        (removed) => {
          if (removed > 0) app.log.info({ removed }, "app_visits retention sweep");
        },
        (err: unknown) => app.log.warn({ err }, "app_visits retention sweep failed"),
      );
    }, VISIT_SWEEP_INTERVAL_MS);
    sweep.unref();
    app.addHook("onClose", async () => {
      clearInterval(sweep);
    });
  },
  { name: "visitors", dependencies: ["prisma"] },
);
