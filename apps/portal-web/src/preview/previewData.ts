/**
 * Canned data for PREVIEW screens — concepts from the architecture doc
 * (gateway audit, capability manifests, approvals, CSP violations, metering)
 * whose APIs land in M4+. Everything rendered from this file sits behind a
 * PreviewBadge. Vocabulary mirrors docs/platform-architecture.md.
 */

/** Deterministic pseudo-usage so real apps get stable, varied-looking cards. */
export function previewUsageFor(slug: string): {
  reqDay: number;
  tokDay: number;
  tokBudget: number;
  errRate: number;
  spark: number[];
} {
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) % 9973;
  const rand = (n: number) => {
    h = (h * 137 + 41) % 9973;
    return h % n;
  };
  const reqDay = 400 + rand(20000);
  const tokBudget = (1 + rand(5)) * 500_000;
  const tokDay = Math.floor(tokBudget * (0.15 + rand(70) / 100));
  const spark = Array.from({ length: 16 }, (_, i) => 4 + rand(20) + i * (rand(3) / 2));
  return { reqDay, tokDay, tokBudget, errRate: rand(30) / 10, spark };
}

export const PREVIEW_PLATFORM = {
  tokens14d: [1.1, 1.3, 1.2, 1.6, 1.9, 1.7, 2.2, 2.4, 2.1, 2.8, 3.1, 2.9, 3.4, 3.8], // millions
  requests14d: [58, 62, 60, 71, 78, 74, 86, 92, 88, 101, 108, 104, 118, 131], // thousands
  costByApp: [
    { app: "design-critique", cost: 184.2, pct: 38 },
    { app: "cost-explorer", cost: 121.4, pct: 25 },
    { app: "standup-bot", cost: 58.1, pct: 12 },
    { app: "incident-timeline", cost: 43.9, pct: 9 },
    { app: "release-notes", cost: 34.7, pct: 7 },
    { app: "customer-demo", cost: 24.3, pct: 5 },
    { app: "status-page", cost: 19.8, pct: 4 },
  ],
  totals: { mtdCost: 486.4, tokensMTD: "48.2M", requestsMTD: "1.94M", activeUsers: 71 },
  capabilityMix: [
    ["LLM", 62, "var(--az-info)"],
    ["Data", 22, "var(--az-acc)"],
    ["MCP", 9, "var(--az-violet)"],
    ["Fetch", 7, "var(--az-warn)"],
  ] as Array<[string, number, string]>,
};

export interface PreviewAuditRow {
  t: string;
  app: string;
  user: string;
  cap: string;
  target: string;
  out: "ok" | "blocked" | "quota" | "denied";
  tok: number;
  cost: number;
}

export const PREVIEW_AUDIT: PreviewAuditRow[] = [
  {
    t: "14:32:08",
    app: "design-critique",
    user: "mara@azx.dev",
    cap: "llm.chat",
    target: "claude-fable-5",
    out: "ok",
    tok: 8400,
    cost: 0.084,
  },
  {
    t: "14:32:01",
    app: "cost-explorer",
    user: "alice@azx.dev",
    cap: "mcp.azure-billing",
    target: "—",
    out: "ok",
    tok: 0,
    cost: 0.002,
  },
  {
    t: "14:31:54",
    app: "design-critique",
    user: "mara@azx.dev",
    cap: "llm.chat",
    target: "gpt-5",
    out: "quota",
    tok: 0,
    cost: 0,
  },
  {
    t: "14:31:40",
    app: "standup-bot",
    user: "bob@azx.dev",
    cap: "data.write",
    target: "—",
    out: "ok",
    tok: 0,
    cost: 0,
  },
  {
    t: "14:31:22",
    app: "customer-demo",
    user: "anon·a91f",
    cap: "llm.chat",
    target: "gpt-5",
    out: "ok",
    tok: 1200,
    cost: 0.012,
  },
  {
    t: "14:31:09",
    app: "incident-timeline",
    user: "theo@azx.dev",
    cap: "fetch",
    target: "api.statuspage.io",
    out: "blocked",
    tok: 0,
    cost: 0,
  },
  {
    t: "14:30:58",
    app: "cost-explorer",
    user: "alice@azx.dev",
    cap: "llm.chat",
    target: "gpt-5",
    out: "ok",
    tok: 5600,
    cost: 0.056,
  },
  {
    t: "14:30:41",
    app: "status-page",
    user: "anon",
    cap: "data.read",
    target: "—",
    out: "ok",
    tok: 0,
    cost: 0,
  },
  {
    t: "14:30:12",
    app: "standup-bot",
    user: "sam@azx.dev",
    cap: "llm.chat",
    target: "gpt-5",
    out: "ok",
    tok: 3200,
    cost: 0.032,
  },
  {
    t: "14:29:55",
    app: "release-notes",
    user: "ci·deploy",
    cap: "mcp.github-readonly",
    target: "—",
    out: "ok",
    tok: 0,
    cost: 0.001,
  },
  {
    t: "14:29:40",
    app: "customer-demo",
    user: "anon·77b2",
    cap: "data.write",
    target: "—",
    out: "denied",
    tok: 0,
    cost: 0,
  },
  {
    t: "14:29:21",
    app: "cost-explorer",
    user: "alice@azx.dev",
    cap: "llm.embeddings",
    target: "text-embed-3",
    out: "ok",
    tok: 900,
    cost: 0.001,
  },
  {
    t: "14:28:46",
    app: "incident-timeline",
    user: "theo@azx.dev",
    cap: "mcp.pagerduty",
    target: "—",
    out: "ok",
    tok: 0,
    cost: 0.003,
  },
  {
    t: "14:28:22",
    app: "standup-bot",
    user: "bob@azx.dev",
    cap: "data.read",
    target: "—",
    out: "ok",
    tok: 0,
    cost: 0,
  },
];

export interface PreviewApproval {
  id: string;
  kind: "go-public" | "mcp-grant" | "origin-grant" | "llm-budget";
  app: string;
  owner: string;
  ago: string;
  risk: "high" | "med" | "low";
  summary: string;
  detail: string;
  diff: Array<[key: string, from: string, to: string]>;
}

export const PREVIEW_APPROVALS: PreviewApproval[] = [
  {
    id: "apr-1",
    kind: "go-public",
    app: "status-page",
    owner: "Dana L.",
    ago: "18m",
    risk: "high",
    summary: "Make Status Page publicly reachable (no SSO gate).",
    detail:
      "Public apps get anonymous-tier quotas + per-IP limits and lose user-scoped storage. Highest-risk action in the system.",
    diff: [["visibility", "group:eng-team", "public"]],
  },
  {
    id: "apr-2",
    kind: "mcp-grant",
    app: "incident-timeline",
    owner: "Theo K.",
    ago: "24m",
    risk: "med",
    summary: "Grant MCP server: pagerduty",
    detail:
      "App requests the pagerduty MCP passthrough to read incident streams. Any-MCP grants require admin approval.",
    diff: [["mcp", "[]", "[pagerduty]"]],
  },
  {
    id: "apr-3",
    kind: "origin-grant",
    app: "incident-timeline",
    owner: "Theo K.",
    ago: "24m",
    risk: "low",
    summary: "Add external origin: api.statuspage.io",
    detail:
      "Adds a connect-src CSP exception. Routine third-party fetches are funneled through the gateway fetch-proxy.",
    diff: [["external_origins", "[]", "[api.statuspage.io]"]],
  },
  {
    id: "apr-4",
    kind: "llm-budget",
    app: "design-critique",
    owner: "Mara S.",
    ago: "2h",
    risk: "med",
    summary: "Raise LLM budget 3M → 6M tokens/day",
    detail:
      "High LLM budgets above the baseline require approval. Current usage is 2.91M/day, trending up.",
    diff: [["llm.tokens_per_day", "3,000,000", "6,000,000"]],
  },
];

export interface PreviewViolation {
  id: string;
  app: string;
  directive: string;
  blocked: string;
  count: number;
  last: string;
  requested: boolean;
  plain: string;
  danger?: boolean;
}

export const PREVIEW_VIOLATIONS: PreviewViolation[] = [
  {
    id: "v-1",
    app: "design-critique",
    directive: "connect-src",
    blocked: "https://api.weather.com/v1/forecast",
    count: 142,
    last: "3m",
    requested: false,
    plain: "Your app tried to call api.weather.com and was blocked.",
  },
  {
    id: "v-2",
    app: "cost-explorer",
    directive: "connect-src",
    blocked: "https://api.exchangerate.host/latest",
    count: 38,
    last: "27m",
    requested: false,
    plain: "Cost Explorer tried to call api.exchangerate.host and was blocked.",
  },
  {
    id: "v-3",
    app: "standup-bot",
    directive: "connect-src",
    blocked: "https://hooks.slack.com/services/…",
    count: 9,
    last: "1h",
    requested: true,
    plain: "Standup Bot tried to POST to hooks.slack.com — capability request filed.",
  },
  {
    id: "v-4",
    app: "design-critique",
    directive: "form-action",
    blocked: "https://evil-collector.example",
    count: 3,
    last: "2h",
    requested: false,
    danger: true,
    plain: "Blocked a cross-origin form POST — possible exfiltration attempt.",
  },
];

/** Capability manifest mock for the app-detail Capabilities tab (M4 shape, §6.3). */
export const PREVIEW_CAPS = {
  llm: { models: ["gpt-5", "claude-fable-5"], tokensPerDay: 2_000_000 },
  data: { appScope: true, userScope: true },
  mcp: ["azure-billing"],
  origins: [] as string[],
};
