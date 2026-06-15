/**
 * Canned data for the remaining PREVIEW screens — concepts whose APIs land
 * later: capability approvals (v1) and CSP violations (v1.x). Everything
 * rendered from this file sits behind a PreviewBadge. Vocabulary mirrors
 * docs/platform-architecture.md. (Capabilities, per-app usage, the audit log,
 * and platform rollups are now backed by the real M4 gateway data.)
 */

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
