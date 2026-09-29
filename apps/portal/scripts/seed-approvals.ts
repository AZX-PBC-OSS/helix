import { createPrismaClient } from "../src/db/client.js";
import {
  applyDeltas,
  captureSnapshot,
  classifyChange,
  classifyVisibilityChange,
  touchedAreas,
  type ApprovalStatus,
  type Delta,
  type VisibilityState,
} from "@azx-pbc/shared";

/**
 * Dev convenience: seed the approvals queue with demo apps that exercise every
 * chip the queue renders — capability shapes (MCP, origins, prefixes, budgets,
 * offline, visibility), per-delta risk levels, provider-bound stamps, and every
 * branch of the prior-decision display (issue #26). Log into the portal as the
 * platform admin (alice@azx.dev) and open **Admin → Approvals** to see them.
 * Idempotent — it deletes and recreates the `demo-*` apps each run (cascade
 * drops their requests), so re-run freely. Never touches non-`demo-` data.
 *
 * Deltas are built by running the REAL classifier (`classifyChange` /
 * `classifyVisibilityChange`) over an effective→requested pair, so the queue
 * demos the exact wire shape production files — per-delta `risk` included —
 * and cannot drift from the classifier's rules. `baseSnapshot` is captured the
 * same way the portal files it, so approving these demo requests succeeds.
 *
 * Usage (from repo root):
 *   pnpm --filter @azx-pbc/portal exec tsx scripts/seed-approvals.ts
 *   pnpm --filter @azx-pbc/portal exec tsx scripts/seed-approvals.ts -- --clean   # remove only
 */

// `actor.sub` is the email for an OIDC login (apps/portal/src/auth/verifier.ts),
// so requester/decider read as the dev-idp fixture emails.
const REQUESTER = "bob@azx.dev"; // a non-admin owner
const ADMIN = "alice@azx.dev"; // the platform admin who decides

const now = Date.now();
/** A timestamp `mins` minutes in the past (so timeAgo renders "3h ago", "2d ago"). */
const ago = (mins: number) => new Date(now - mins * 60_000);
const HOUR = 60;
const DAY = 24 * HOUR;

/**
 * One approval request to file. Capability requests give an effective→requested
 * pair for the classifier; visibility requests give the from/to states instead.
 */
interface ReqSeed {
  status: ApprovalStatus;
  /** The app's effective capabilities when the request was filed. */
  effective: unknown;
  /** The requested manifest (capability requests only). */
  requested?: unknown;
  /** Visibility requests only: the from/to states. */
  visibility?: { from: VisibilityState; to: VisibilityState };
  /** Decorate this request's provider-bound fetch-origin delta with a live stamp (and warning). */
  providerBinding?: { publicApp: boolean };
  reason?: string;
  decisionNote?: string;
  createdAt: Date;
  decidedAt?: Date;
}

interface AppSeed {
  slug: string;
  displayName: string;
  /** App visibility mode while the requests are open (drives the public-app warning). */
  visibilityMode: "internal" | "public" | "password" | "group";
  /**
   * The app's stored capabilities. Defaults to the pending request's effective
   * state plus its baseline-applied part — set explicitly only when decided
   * history actually landed (an approved grant in the log).
   */
  capabilities?: unknown;
  requests: ReqSeed[];
}

const internal: VisibilityState = { mode: "internal" };

/** The demo delegation provider the provider-bound demos bind to (created once, env `prod`). */
const PROVIDER_REF = "asana";

function buildRequest(seed: ReqSeed, providerId: string, filingVisibility: VisibilityState) {
  if (seed.visibility) {
    const change = classifyVisibilityChange(seed.visibility.from, seed.visibility.to);
    if (!change) throw new Error(`${seed.status}: visibility states compare equal`);
    return {
      deltas: [change.delta] as Delta[],
      risk: change.risk,
      baseSnapshot: captureSnapshot(seed.effective, seed.visibility.from, ["visibility"]) as object,
      effectiveCaps: seed.effective as object,
    };
  }

  const cls = classifyChange(seed.effective, seed.requested ?? {});
  const deltas = cls.elevatedDeltas.map((d) => {
    const isProviderBound = d.path.startsWith("fetch.origins[+") && d.path.includes("→provider:");
    if (!seed.providerBinding || !isProviderBound) return d;
    return {
      ...d,
      // The stamps the portal files: the provider row's identity at filing time.
      providerStamps: [{ ref: PROVIDER_REF, env: "prod", providerId, revision: 1 }],
      publicApp: seed.providerBinding.publicApp,
    };
  });
  return {
    deltas,
    risk: cls.risk,
    baseSnapshot: captureSnapshot(
      seed.effective,
      filingVisibility,
      touchedAreas(cls.elevatedDeltas),
    ),
    // What the PUT already landed (baseline deltas apply immediately).
    effectiveCaps: applyDeltas(seed.effective, cls.baselineDeltas),
  };
}

const APPS: AppSeed[] = [
  // A) Loud flag: the exact grant denied three times, refiled a fourth.
  {
    slug: "demo-paging-bot",
    displayName: "Paging Bot",
    visibilityMode: "internal",
    requests: [
      ...[0, 1, 2].map((i) => ({
        status: "denied" as ApprovalStatus,
        effective: { mcp: [] },
        requested: { mcp: ["pagerduty"] },
        reason: [
          "Wire up PagerDuty so the bot can page on-call.",
          "Scoped down, re-requesting PagerDuty MCP.",
          "Please approve, we really need this.",
        ][i],
        decisionNote: [
          "Too broad — scope to a single service first.",
          "Still no runbook link — how does an untrusted app page a human?",
          "Denied again — see the two prior notes before refiling.",
        ][i],
        createdAt: ago((6 - i * 2) * DAY + HOUR),
        decidedAt: ago((6 - i * 2) * DAY),
      })),
      {
        status: "pending",
        effective: { mcp: [] },
        requested: { mcp: ["pagerduty"] },
        reason:
          "We now have an on-call runbook and single-service scoping. Requesting PagerDuty MCP.",
        createdAt: ago(3 * HOUR),
      },
    ],
  },

  // B) Quiet flag: a *different* MCP server was denied — same area, not the same grant.
  {
    slug: "demo-analytics",
    displayName: "Analytics Dashboard",
    visibilityMode: "internal",
    requests: [
      {
        status: "denied",
        effective: { mcp: [] },
        requested: { mcp: ["slack"] },
        reason: "Post daily metrics to Slack.",
        decisionNote: "We don't allow outbound Slack MCP from analytics apps.",
        createdAt: ago(5 * DAY + HOUR),
        decidedAt: ago(5 * DAY),
      },
      {
        status: "pending",
        effective: { mcp: [] },
        requested: { mcp: ["datadog"] },
        reason: "Requesting Datadog MCP to read dashboard metrics.",
        createdAt: ago(70),
      },
    ],
  },

  // C) No flag, non-denied "last decision": prior approval + a needs_changes bounce,
  //    now a resubmit at a lower budget. Shows a mixed-status history log.
  {
    slug: "demo-budget",
    displayName: "Budget Planner",
    visibilityMode: "internal",
    // The approved MCP grant from history landed on the app row.
    capabilities: { mcp: ["github"], llm: { models: [], dollarsPerDay: 50 } },
    requests: [
      {
        status: "approved",
        effective: { mcp: [] },
        requested: { mcp: ["github"] },
        reason: "Read issues from GitHub for planning.",
        createdAt: ago(10 * DAY + HOUR),
        decidedAt: ago(10 * DAY),
      },
      {
        status: "needs_changes",
        effective: { llm: { models: [], dollarsPerDay: 50 } },
        requested: { llm: { models: [], dollarsPerDay: 500 } },
        reason: "Bump the daily LLM budget to $500 for batch planning.",
        decisionNote: "Justify the 10× jump or lower it — $500/day is a lot for a planner.",
        createdAt: ago(3 * DAY + HOUR),
        decidedAt: ago(3 * DAY),
      },
      {
        status: "pending",
        effective: { llm: { models: [], dollarsPerDay: 50 } },
        requested: { llm: { models: [], dollarsPerDay: 200 } },
        reason: "Lowered the ask to $200/day as requested.",
        createdAt: ago(20),
      },
    ],
  },

  // D) Clean first-time request: no history, so no flag and no History toggle.
  {
    slug: "demo-stripe",
    displayName: "Stripe Checkout",
    visibilityMode: "internal",
    requests: [
      {
        status: "pending",
        effective: {},
        requested: { externalOrigins: ["https://api.stripe.com"] },
        reason: "Call the Stripe API directly from the checkout page.",
        createdAt: ago(45),
      },
    ],
  },

  // E) Visibility "Go public", previously denied — loud flag on a non-capability delta.
  {
    slug: "demo-blog",
    displayName: "Public Blog",
    visibilityMode: "internal",
    requests: [
      {
        status: "denied",
        effective: {},
        visibility: { from: internal, to: { mode: "public" } },
        reason: "Make the blog public.",
        decisionNote: "Not until anonymous rate limiting is in place.",
        createdAt: ago(8 * DAY + HOUR),
        decidedAt: ago(8 * DAY),
      },
      {
        status: "pending",
        effective: {},
        visibility: { from: internal, to: { mode: "public" } },
        reason: "Added per-IP rate limiting — re-requesting public visibility.",
        createdAt: ago(2 * HOUR),
      },
    ],
  },

  // F) Simple: one elevated-but-routine delta — a shared key prefix. In the
  //    queue for a human to see, but rated low (app-scoped by definition).
  {
    slug: "demo-notes",
    displayName: "Field Notes",
    visibilityMode: "internal",
    requests: [
      {
        status: "pending",
        effective: {},
        requested: { data: { sharedWritePrefixes: ["record:"], writesPerDay: 1000 } },
        reason: "Let each user keep a record: notes row per run; the budget bounds row creation.",
        createdAt: ago(90),
      },
    ],
  },

  // F2) A "list" ask: requesting several MCP servers in one submission. The
  //     classifier emits one delta per server, so the card renders one chip row
  //     per item — each with its own risk badge and its own prior-decision
  //     matching — rather than one chip carrying a list.
  {
    slug: "demo-toolbelt",
    displayName: "Toolbelt",
    visibilityMode: "internal",
    requests: [
      {
        status: "pending",
        effective: {},
        requested: { mcp: ["pagerduty", "datadog", "github"] },
        reason: "Requesting the three on-call servers in one go — same access, one review.",
        createdAt: ago(40),
      },
    ],
  },

  // G) Medium: a three-change bundle with mixed per-delta risk — high (secret-bound
  //    origin), med (uncurated model), low (read prefix) — so the aggregate badge's
  //    "highest of" breakdown has all three levels to show.
  {
    slug: "demo-pulse",
    displayName: "Pulse Reporter",
    visibilityMode: "internal",
    requests: [
      {
        status: "pending",
        effective: {},
        requested: {
          llm: { models: ["gpt-5"] },
          fetch: { origins: [{ origin: "https://api.github.com", connection: "gh-pat" }] },
          data: { sharedReadPrefixes: ["cfg:"] },
        },
        reason:
          "Summarize repo activity with gpt-5, read team config from the shared store, and call the GitHub API with the stored team token.",
        createdAt: ago(6 * HOUR),
      },
    ],
  },

  // H) Kitchen sink: a public app filing one of everything — MCP, direct origin,
  //    model + budget, both prefix grants, a provider-bound delegated origin (with
  //    a live stamp, so approving it actually lands), a keyless origin, a proxy
  //    budget raise, and an offline grant. The public-app warning Hint fires
  //    because the app is public while requesting the provider binding.
  {
    slug: "demo-ops-hub",
    displayName: "Ops Hub",
    visibilityMode: "public",
    requests: [
      {
        status: "pending",
        effective: {},
        providerBinding: { publicApp: true },
        requested: {
          mcp: ["github"],
          externalOrigins: ["https://api.stripe.com"],
          llm: { models: ["gpt-5"], dollarsPerDay: 200 },
          data: {
            user: true,
            collections: ["tasks"],
            sharedRead: [],
            sharedWrite: [],
            sharedReadPrefixes: ["cfg:"],
            sharedWritePrefixes: ["record:"],
            writesPerDay: 1000,
          },
          fetch: {
            origins: [
              { origin: "https://api.asana.com", provider: PROVIDER_REF },
              { origin: "https://httpbin.org" },
            ],
            requestsPerDay: 20_000,
          },
          offline: { scope: "/app/" },
        },
        reason:
          "Everything the ops hub needs — delegated Asana tasks, billing lookups, summaries, and offline support.",
        createdAt: ago(26 * HOUR),
      },
    ],
  },
];

async function main(): Promise<void> {
  const clean = process.argv.slice(2).includes("--clean");
  const prisma = createPrismaClient();
  const slugs = APPS.map((a) => a.slug);
  try {
    const removed = await prisma.app.deleteMany({ where: { slug: { in: slugs } } });
    if (removed.count > 0) console.log(`removed ${removed.count} existing demo app(s)`);
    if (clean) {
      console.log("clean only — nothing seeded.");
      return;
    }

    // The delegation provider the provider-bound demo stamps. Upsert so re-runs
    // keep one stable row (revision 1 — a fresh seed never stales its own stamps).
    const provider = await prisma.connectionProvider.upsert({
      where: { ref_env: { ref: PROVIDER_REF, env: "prod" } },
      create: {
        ref: PROVIDER_REF,
        kind: "rest-delegated",
        displayName: "Asana (demo)",
        authorizeEndpoint: "https://app.asana.com/-/oauth_authorize",
        tokenEndpoint: "https://app.asana.com/api/1.0/oauth_token",
        requestedScopes: [],
        apiOrigins: ["https://api.asana.com"],
        tokenPlacement: { kind: "header-bearer" },
        env: "prod",
        clientIdMaterial: "demo-client-id",
        clientSecretMaterial: "demo-client-secret",
      },
      update: {},
    });

    for (const seed of APPS) {
      const pending = seed.requests.filter((r) => r.status === "pending");
      const built = seed.requests.map((r) => ({
        seed: r,
        filed: buildRequest(r, provider.id, { mode: seed.visibilityMode }),
      }));

      const app = await prisma.app.create({
        data: {
          slug: seed.slug,
          displayName: seed.displayName,
          ownerId: REQUESTER,
          visibilityMode: seed.visibilityMode,
          visibilityGroupIds: [],
          capabilities: (seed.capabilities ??
            built.findLast((b) => b.seed.status === "pending")?.filed.effectiveCaps ??
            {}) as object,
        },
      });
      for (const { seed: r, filed } of built) {
        await prisma.approvalRequest.create({
          data: {
            appId: app.id,
            status: r.status,
            risk: filed.risk,
            deltas: filed.deltas as object,
            baseSnapshot: filed.baseSnapshot as object,
            requestedBy: REQUESTER,
            reason: r.reason ?? null,
            decidedBy: r.status === "pending" ? null : ADMIN,
            decisionNote: r.decisionNote ?? null,
            createdAt: r.createdAt,
            decidedAt: r.decidedAt ?? null,
          },
        });
      }
      const prior = seed.requests.length - pending.length;
      console.log(`seeded ${seed.slug} — ${pending.length} pending, ${prior} prior decision(s)`);
    }
    console.log(`\nDone. Log in as ${ADMIN} and open Admin → Approvals.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
