import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DirectoryGroupsResponseSchema, type DirectoryGroupsResponse } from "@azx-pbc/shared";
import {
  DirectoryError,
  GRAPH_GROUP_PERMISSION,
  MAX_SEARCH_RESULTS,
  MIN_SEARCH_LENGTH,
  type DirectoryOutcome,
  type GroupName,
  type GroupSummary,
} from "@azx-pbc/directory";
import { authenticate, ownsApp, requireActor } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { bumpSearchLimit, RATE_BUCKETS, SEARCH_LIMIT } from "../directory/rateLimit.js";
import { directorySearchAllowed, directorySearchTier } from "../policy/directoryPolicy.js";

/**
 * Directory group lookup for the Access tab's group picker (ADR-0040 §4).
 *
 * **This is a new information-disclosure surface the platform adds to itself**,
 * distinct from anything Graph does: search turns a three-letter term into group
 * display names from anywhere in the tenant. It cannot be narrowed with `ownsApp`
 * — the picker is needed at app-*create* time, before an app exists — and portal
 * reads are still authenticated-only under ADR-0007 (per-app RBAC is the
 * outstanding `PreviewBadge`). So it ships restrictive on four axes, all of which
 * ADR-0040's consequences commit to: a minimum query length so there are no
 * bare-prefix directory dumps, a hard result cap, a per-actor rate limit, and an
 * audit row. Loosening any of them later is easy; tightening after someone depends
 * on it is not.
 *
 * **Who may search at all is a deployment setting** — `PORTAL_DIRECTORY_SEARCH`,
 * decision 11, resolved in `../policy/directoryPolicy.ts`. It defaults to
 * `everyone`, which is the posture described above and the one ADR-0040 shipped;
 * `admins` and `none` narrow it.
 *
 * The tier gates the search route outright. It does **not** gate `my-groups`,
 * which resolves the group claim on the caller's own verified token and so
 * genuinely hands back nothing new. The app-scoped resolve sits between the two
 * and is discussed at the route itself: a first pass excused it with the same
 * "nothing the caller could not already read" argument, which turned out to be
 * false, so on a restricted deployment it additionally requires owner-or-admin.
 *
 * Neither route can 500 on an unconfigured or unconsented directory: the provider
 * reports absence as a value and both routes answer **200 with
 * `available: false`** (decision 8). The Access tab then falls back to free-text
 * group ids behind a banner naming the missing permission, and group visibility
 * keeps working end to end — enforcement never depended on Graph, only the picker
 * does.
 */

/**
 * Require owner-or-admin on the app-scoped resolve, but **only where a tier is
 * actually set** (ADR-0040 decision 11).
 *
 * Conditional rather than always-on, because the resolve has a second consumer:
 * `GroupVisibilityBadge` (`apps/portal-web/src/components/primitives.tsx`) names
 * an app's groups on hover from the apps table, for *any* row the caller can see.
 * Gating unconditionally would degrade that to "unknown group" on every
 * deployment — including the `everyone` default, which by definition has no
 * disclosure posture to enforce. Paying a UX cost where there is no benefit is
 * how a security control gets removed later by someone who only sees the cost.
 *
 * `ownsApp` is reused verbatim rather than reimplemented as an `ownerId` compare:
 * it already allows owner-**or**-admin, already fails closed on a null `ownerId`,
 * and already emits the ownership-denied warn line. Its own 404-on-missing-app
 * also fires before the handler's, which keeps "no such app" indistinguishable
 * from "not yours" for a caller probing slugs.
 */
async function ownsAppWhenSearchRestricted(req: FastifyRequest): Promise<void> {
  if (directorySearchTier() === "everyone") return;
  await ownsApp(req);
}

const SearchQuerySchema = z.object({
  /**
   * Minimum length enforced here as well as inside the provider. Two layers, on
   * purpose: this one produces a clean 400 with the shared error envelope, and
   * the provider's protects any future non-HTTP caller.
   */
  q: z.string().trim().min(MIN_SEARCH_LENGTH),
  top: z.coerce.number().int().positive().max(MAX_SEARCH_RESULTS).default(10),
});

export async function directoryRoutes(app: FastifyInstance): Promise<void> {
  const audit = (actor: string, action: string, metadata: object = {}) =>
    // `appId: null` — a directory read is not app-scoped. The column is nullable
    // precisely so non-app events are expressible.
    app.prisma.auditEvent.create({ data: { appId: null, actor, action, metadata } });

  /**
   * Translate a provider outcome into the wire shape, so both routes degrade
   * identically and neither has to remember to.
   */
  /**
   * Run a directory call and turn a *transient* failure into a typed 503.
   *
   * `DirectoryError` is not an `AppError`, so without this the error plugin mapped
   * it to a bare 500 — and once Graph starts 429ing (its own throttle, which the
   * per-actor limit reduces but cannot remove), the SPA sees an errored query with
   * no data, so its `unavailable` check stays null, no banner renders, and the
   * picker says "no matching groups". A throttled directory read as "that group
   * does not exist", for every operator at once.
   *
   * `capability_unavailable` (-> 503) rather than a fabricated `available: false`:
   * the whole point of that shape is that it means "permanently, until an operator
   * acts", and a Graph blip is neither. A 503 is retryable and says so.
   */
  const attempt = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (err) {
      if (err instanceof DirectoryError) {
        app.log.warn({ err, what }, "directory call failed");
        throw new AppError(
          "capability_unavailable",
          "the directory did not answer — try again shortly",
        );
      }
      throw err;
    }
  };

  const respond = <T extends GroupSummary[] | GroupName[]>(
    outcome: DirectoryOutcome<T>,
  ): DirectoryGroupsResponse => {
    if (!outcome.available) {
      return DirectoryGroupsResponseSchema.parse({
        available: false,
        reason: outcome.reason,
        detail: outcome.detail,
        // Only worth naming when a grant is genuinely what's missing. On a
        // deployment with no directory, or one that cannot get a token, there is
        // no permission to ask anyone for — and pointing the operator at an
        // administrator would send them to the wrong person entirely.
        ...(outcome.reason === "no-consent" ? { missingPermission: GRAPH_GROUP_PERMISSION } : {}),
      });
    }
    return DirectoryGroupsResponseSchema.parse({
      available: true,
      // The security flag is forwarded only when the provider reported one.
      // Omitted, never defaulted: a made-up `true` is indistinguishable from a
      // real answer, and the picker has to be able to tell.
      groups: outcome.value.map((g) => ({
        id: g.id,
        displayName: g.displayName,
        ...(typeof g.securityEnabled === "boolean" ? { securityEnabled: g.securityEnabled } : {}),
      })),
    });
  };

  /**
   * Spend a resolve from this actor's budget, or refuse.
   *
   * Both id -> name routes issue a `getByIds` to Graph on every request, and for a
   * while neither was limited: the route comment justified that on
   * information-disclosure grounds ("a caller who can read this route can already
   * read those same ids"), which is true and answers the wrong question. The
   * resource being spent is the **tenant's shared Graph throttle budget**, which
   * is exactly why the search route limits *before* its upstream call. Same
   * reasoning, same fix, looser number — a resolve is page-render traffic.
   */
  const requireResolveBudget = async (req: FastifyRequest, sub: string): Promise<void> => {
    const verdict = await bumpSearchLimit(app.prisma, sub, "resolve");
    if (!verdict.allowed) {
      req.log.warn(
        { actor: sub, count: verdict.count, limit: RATE_BUCKETS.resolve.limit },
        "directory resolve rate limit exceeded",
      );
      throw new AppError("rate_limited", "too many directory lookups — try again shortly");
    }
  };

  // Search the tenant's groups. See the restrictions in the module comment.
  app.get<{ Querystring: { q?: string; top?: string } }>(
    "/api/v1/directory/groups",
    { preHandler: authenticate },
    async (req): Promise<DirectoryGroupsResponse> => {
      const actor = requireActor(req);
      const { q, top } = SearchQuerySchema.parse(req.query);

      /**
       * Who may search at all (ADR-0040 decision 11). Checked BEFORE the rate
       * limit, so a refused caller neither spends their own budget nor costs a
       * write to `portal_rate_counters` — refusing a request should be the
       * cheapest thing this route does.
       *
       * Logged, never audited. `requireAdmin` sets that precedent, and the
       * reason is sharper here: the rate limit deliberately does not run on this
       * path, so auditing the denial would hand any authenticated principal an
       * unbounded INSERT into `audit_events`. The interesting audit record is a
       * search that *happened*, which is still written below.
       *
       * The log line mirrors `requireAdmin`'s fields for the same reason it has
       * them: after the Entra swap the most confusing failure by far is an
       * authenticated user who simply is not assigned `platform-admin`, and
       * "search stopped working for one person" needs to be greppable.
       */
      if (!directorySearchAllowed(actor)) {
        req.log.warn(
          { actor: actor.sub, via: actor.via, tier: directorySearchTier() },
          "directory search denied: this deployment restricts search and the actor does not qualify",
        );
        throw new AppError(
          "forbidden",
          "group search is restricted on this deployment — you can still pick from your own " +
            "groups, or add a group by id",
        );
      }

      // Rate limit BEFORE the upstream call, so a flood costs us one cheap upsert
      // rather than a Graph round trip (and our Graph throttle budget) each.
      const verdict = await bumpSearchLimit(app.prisma, actor.sub);
      if (!verdict.allowed) {
        req.log.warn(
          { actor: actor.sub, count: verdict.count, limit: SEARCH_LIMIT },
          "directory search rate limit exceeded",
        );
        throw new AppError("rate_limited", "too many directory searches — try again shortly");
      }

      const outcome = await attempt("searchGroups", () => app.directory.searchGroups(q, top));
      // Audited whether or not it found anything: the interesting record is that
      // this principal searched the directory for this term, which is exactly
      // what the new disclosure surface is.
      await audit(actor.sub, "directory.search", {
        q,
        resultCount: outcome.available ? outcome.value.length : 0,
        available: outcome.available,
      });
      return respond(outcome);
    },
  );

  /**
   * Resolve **one app's own** stored group ids to names (ADR-0040 §7).
   *
   * App-scoped on purpose, rather than a general `?ids=…` resolver — a general
   * one would be a flat "does this GUID name a group, and what is it called"
   * oracle for arbitrary input, which is a bigger ask than the search endpoint
   * above and buys nothing the picker needs.
   *
   * **Being app-scoped is a smaller mitigation than it first appears, and the
   * original reasoning here was wrong.** It said a caller who can read this route
   * can already read the same ids from `GET /api/v1/apps/:slug`, so nothing is
   * disclosed. True of the *ids*; false of the *names*, and false in a way that
   * matters, because the caller chooses the ids: `POST /api/v1/apps` is
   * authenticate-only and `VisibilityGroupIdsSchema` never validates a group id
   * against the directory. Store ten arbitrary ids on an app of your own, read
   * this route, and you have resolved ten names with search refused — and since
   * ids that do not resolve are silently omitted, you have also learned which of
   * them exist.
   *
   * So on any deployment that set a tier this additionally requires
   * owner-or-admin ({@link ownsAppWhenSearchRestricted}). What is left is an
   * operator naming groups on their own apps, ten ids at a time against the
   * resolve limiter, with no name→id direction and no way to guess an Entra
   * object id — a real residual, bounded, and not one that defeats the tier.
   * Removing it altogether is per-app RBAC (ADR-0007), not this knob.
   *
   * Names live nowhere but this response: there is deliberately no name column on
   * `App`, because a second, staler copy of a name sitting beside a live
   * authorization value invites exactly one bug — disagreeing about which is real
   * — and the UI would show the wrong one.
   */
  app.get<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/visibility/groups",
    { preHandler: [authenticate, ownsAppWhenSearchRestricted] },
    async (req): Promise<DirectoryGroupsResponse> => {
      const actor = requireActor(req);
      const row = await app.prisma.app.findUnique({
        where: { slug: req.params.slug },
        select: { visibilityGroupIds: true },
      });
      if (!row) throw new AppError("not_found", `app "${req.params.slug}" not found`);
      if (row.visibilityGroupIds.length === 0) {
        // No Graph call, so nothing to limit — and a group-less app must not spend
        // anyone's budget just by being opened.
        return DirectoryGroupsResponseSchema.parse({ available: true, groups: [] });
      }
      await requireResolveBudget(req, actor.sub);
      return respond(
        await attempt("getGroups", () => app.directory.getGroups(row.visibilityGroupIds)),
      );
    },
  );

  /**
   * The groups the caller is in — the picker's default view.
   *
   * Served from the **groups claim on the caller's own already-verified access
   * token** (`Actor.groups`), not from Graph and not from a delegated
   * `User.Read` token (ADR-0040 decision 6). The rejected alternative worked and
   * needed no administrator, but required the portal to hold or forward a user
   * access token — new, durable credential surface on the control plane — in
   * exchange for information a token we already verify carries for free. It also
   * dragged in Graph's `/me/memberOf` null-payload trap; this route cannot reach
   * that endpoint at all.
   *
   * `Actor.groups` is the union of the `groups` and `roles` claims, so it holds
   * App Role values (`platform-admin`) beside group ids. Nothing here filters
   * them: `EntraDirectory.getGroups` drops non-GUID ids before calling Graph, and
   * anything that doesn't resolve is simply omitted. That keeps the shape
   * knowledge in the one place that has to have it.
   */
  app.get(
    "/api/v1/directory/my-groups",
    { preHandler: authenticate },
    async (req): Promise<DirectoryGroupsResponse> => {
      const actor = requireActor(req);
      if (actor.groups.length === 0) {
        // Not a degradation — the caller genuinely has no group claims. Answering
        // `available: true` with an empty list keeps the picker's banner reserved
        // for the case an operator can actually act on.
        return DirectoryGroupsResponseSchema.parse({ available: true, groups: [] });
      }
      await requireResolveBudget(req, actor.sub);
      return respond(await attempt("getGroups", () => app.directory.getGroups(actor.groups)));
    },
  );
}
