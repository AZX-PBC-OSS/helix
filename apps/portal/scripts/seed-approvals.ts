import { createPrismaClient } from "../src/db/client.js";

/**
 * Dev convenience: seed the approvals queue with apps that exercise every branch
 * of the prior-decision display (issue #26). Log into the portal as the platform
 * admin (alice@azx.dev) and open **Admin → Approvals** to see them. Idempotent —
 * it deletes and recreates the `demo-*` apps each run (cascade drops their
 * requests), so re-run freely. Never touches non-`demo-` data.
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

interface ReqSeed {
  status: "pending" | "approved" | "denied" | "needs_changes" | "withdrawn";
  risk: "low" | "med" | "high";
  deltas: unknown;
  baseSnapshot: unknown;
  reason?: string;
  decisionNote?: string;
  createdAt: Date;
  decidedAt?: Date;
}

interface AppSeed {
  slug: string;
  displayName: string;
  capabilities?: unknown;
  requests: ReqSeed[];
}

const mcp = (server: string) => [{ path: `mcp[+${server}]`, to: server }];
const MCP_SNAP = { mcp: [] };

const APPS: AppSeed[] = [
  // A) Loud flag: the exact grant denied three times, refiled a fourth.
  {
    slug: "demo-paging-bot",
    displayName: "Paging Bot",
    requests: [
      {
        status: "denied",
        risk: "high",
        deltas: mcp("pagerduty"),
        baseSnapshot: MCP_SNAP,
        reason: "Wire up PagerDuty so the bot can page on-call.",
        decisionNote: "Too broad — scope to a single service first.",
        createdAt: ago(6 * DAY + HOUR),
        decidedAt: ago(6 * DAY),
      },
      {
        status: "denied",
        risk: "high",
        deltas: mcp("pagerduty"),
        baseSnapshot: MCP_SNAP,
        reason: "Scoped down, re-requesting PagerDuty MCP.",
        decisionNote: "Still no runbook link — how does an untrusted app page a human?",
        createdAt: ago(4 * DAY + HOUR),
        decidedAt: ago(4 * DAY),
      },
      {
        status: "denied",
        risk: "high",
        deltas: mcp("pagerduty"),
        baseSnapshot: MCP_SNAP,
        reason: "Please approve, we really need this.",
        decisionNote: "Denied again — see the two prior notes before refiling.",
        createdAt: ago(2 * DAY + HOUR),
        decidedAt: ago(2 * DAY),
      },
      {
        status: "pending",
        risk: "high",
        deltas: mcp("pagerduty"),
        baseSnapshot: MCP_SNAP,
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
    requests: [
      {
        status: "denied",
        risk: "high",
        deltas: mcp("slack"),
        baseSnapshot: MCP_SNAP,
        reason: "Post daily metrics to Slack.",
        decisionNote: "We don't allow outbound Slack MCP from analytics apps.",
        createdAt: ago(5 * DAY + HOUR),
        decidedAt: ago(5 * DAY),
      },
      {
        status: "pending",
        risk: "high",
        deltas: mcp("datadog"),
        baseSnapshot: MCP_SNAP,
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
    capabilities: { mcp: ["github"], externalOrigins: [] },
    requests: [
      {
        status: "approved",
        risk: "high",
        deltas: mcp("github"),
        baseSnapshot: MCP_SNAP,
        reason: "Read issues from GitHub for planning.",
        createdAt: ago(10 * DAY + HOUR),
        decidedAt: ago(10 * DAY),
      },
      {
        status: "needs_changes",
        risk: "med",
        deltas: [{ path: "llm.dollarsPerDay", from: 50, to: 500 }],
        baseSnapshot: { llm: { models: [], dollarsPerDay: 50 } },
        reason: "Bump the daily LLM budget to $500 for batch planning.",
        decisionNote: "Justify the 10× jump or lower it — $500/day is a lot for a planner.",
        createdAt: ago(3 * DAY + HOUR),
        decidedAt: ago(3 * DAY),
      },
      {
        status: "pending",
        risk: "med",
        deltas: [{ path: "llm.dollarsPerDay", from: 50, to: 200 }],
        baseSnapshot: { llm: { models: [], dollarsPerDay: 50 } },
        reason: "Lowered the ask to $200/day as requested.",
        createdAt: ago(20),
      },
    ],
  },

  // D) Clean first-time request: no history, so no flag and no History toggle.
  {
    slug: "demo-stripe",
    displayName: "Stripe Checkout",
    requests: [
      {
        status: "pending",
        risk: "med",
        deltas: [
          { path: "externalOrigins[+https://api.stripe.com]", to: "https://api.stripe.com" },
        ],
        baseSnapshot: { externalOrigins: [] },
        reason: "Call the Stripe API directly from the checkout page.",
        createdAt: ago(45),
      },
    ],
  },

  // E) Visibility "Go public", previously denied — loud flag on a non-capability delta.
  {
    slug: "demo-blog",
    displayName: "Public Blog",
    requests: [
      {
        status: "denied",
        risk: "high",
        deltas: [{ path: "visibility", from: "internal", to: "public" }],
        baseSnapshot: { visibility: "internal" },
        reason: "Make the blog public.",
        decisionNote: "Not until anonymous rate limiting is in place.",
        createdAt: ago(8 * DAY + HOUR),
        decidedAt: ago(8 * DAY),
      },
      {
        status: "pending",
        risk: "high",
        deltas: [{ path: "visibility", from: "internal", to: "public" }],
        baseSnapshot: { visibility: "internal" },
        reason: "Added per-IP rate limiting — re-requesting public visibility.",
        createdAt: ago(2 * HOUR),
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

    for (const seed of APPS) {
      const app = await prisma.app.create({
        data: {
          slug: seed.slug,
          displayName: seed.displayName,
          ownerId: REQUESTER,
          visibilityMode: "internal",
          capabilities: (seed.capabilities ?? {}) as object,
        },
      });
      for (const r of seed.requests) {
        await prisma.approvalRequest.create({
          data: {
            appId: app.id,
            status: r.status,
            risk: r.risk,
            deltas: r.deltas as object,
            baseSnapshot: r.baseSnapshot as object,
            requestedBy: REQUESTER,
            reason: r.reason ?? null,
            decidedBy: r.status === "pending" ? null : ADMIN,
            decisionNote: r.decisionNote ?? null,
            createdAt: r.createdAt,
            decidedAt: r.decidedAt ?? null,
          },
        });
      }
      const pending = seed.requests.filter((r) => r.status === "pending").length;
      const prior = seed.requests.length - pending;
      console.log(`seeded ${seed.slug} — ${pending} pending, ${prior} prior decision(s)`);
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
