import "./style.css";

/**
 * GitHub Repo Report — a platform example (ADR-0031 delegated connections).
 *
 * Two capabilities cooperate:
 *   - **Delegated connection** — `window.helix.connect("github-readonly")` consents
 *     inside a user gesture; provider-bound calls through `/_api/fetch` get the
 *     user's access token injected server-side (the app never sees it). The
 *     boot-time `GET /_api/connections/:ref/status` read decides which panel to
 *     show — a connected banner or a Connect CTA — without firing a wasted API
 *     call. The provider's permissions are fixed on the GitHub App itself, so the
 *     platform requests no scopes at authorize time.
 *   - **LLM gateway** — `POST /_api/llm/chat` streams a report from the activity
 *     digest; the model allowlist lives in the manifest.
 *
 * Nothing is persisted: a report is generated, streamed, and shown. Reloading
 * regenerates it.
 */

const PROVIDER_REF = "github-readonly";
const GITHUB_API = "https://api.github.com";
const MODEL = "gpt-5-nano";

/** Safety rails on the GitHub crawl — a demo, not a warehouse job. */
const MAX_ISSUES = 100;
const MAX_PULLS = 100;
const MAX_COMMITS = 100;
const MESSAGE_CAP = 120;
const TITLE_CAP = 140;

// ---------------------------------------------------------------------------
// Small platform helpers
// ---------------------------------------------------------------------------

/** Thrown by the delegated-call wrapper when the answer is `connection_required`. */
class ConnectionRequired extends Error {
  readonly providerRef: string;
  constructor(ref: string, displayName?: string) {
    super(`connection required for ${displayName ?? ref}`);
    this.providerRef = ref;
  }
}

/**
 * One delegated GitHub GET through the fetch proxy. The proxy answers
 * provider-shaped errors as JSON `{code, message}` instead of an upstream
 * response — mapped to typed errors the UI can act on.
 */
async function ghJson(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`/_api/fetch/${GITHUB_API}${path}`);
  if (res.status !== 200) {
    const body = (await res.json().catch(() => null)) as { code?: string } | null;
    if (res.status === 403 && body?.code === "connection_required") {
      throw new ConnectionRequired(PROVIDER_REF);
    }
    if (res.status === 403 && body?.code === "forbidden") {
      throw new Error("the GitHub origin binding is not approved yet");
    }
    if (res.status === 502 || res.status === 503) {
      throw new Error("the platform could not reach GitHub — is helix-egress running?");
    }
    throw new Error(`GitHub request failed (${res.status}${body?.code ? ` ${body.code}` : ""})`);
  }
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The GitHub activity crawl
// ---------------------------------------------------------------------------

interface GhRepo {
  full_name: string;
  description?: string | null;
  stargazers_count?: number;
  open_issues_count?: number;
  pushed_at?: string;
}

interface GhIssue {
  number: number;
  title: string;
  state: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  user?: { login?: string } | null;
  pull_request?: unknown;
}

interface GhPull {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  closed_at?: string | null;
  user?: { login?: string } | null;
}

interface GhCommit {
  sha: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string } | null;
  } | null;
  author?: { login?: string } | null;
}

interface GhDeployment {
  environment?: string;
  sha?: string;
  created_at?: string;
  creator?: { login?: string } | null;
}

interface GhAlert {
  number: number;
  severity?: string;
  security_advisory?: { summary?: string } | null;
}

interface GhDiscussion {
  number: number;
  title: string;
  created_at: string;
  updated_at: string;
  user?: { login?: string } | null;
}

interface RepoActivity {
  repo: GhRepo;
  issues: GhIssue[];
  pulls: GhPull[];
  commits: GhCommit[];
  deployments: GhDeployment[];
  alerts: GhAlert[];
  discussions: GhDiscussion[];
  /** Which of the optional sections the vendor would not serve. */
  skipped: string[];
}

const inRange = (iso: string | undefined | null, startMs: number, endMs: number): boolean => {
  if (!iso) return false;
  const at = Date.parse(iso);
  return !Number.isNaN(at) && at >= startMs && at < endMs;
};

/**
 * The activity record for one repository over [startMs, endMs). GitHub's list
 * endpoints are cheap here (a user token sits under 5,000 req/hr), so the core
 * sections run in parallel and a failure in an optional section — discussions'
 * REST surface is the youngest — degrades to a skipped note instead of failing
 * the report.
 */
async function collectActivity(
  repoSlug: string,
  startMs: number,
  endMs: number,
  onProgress: (line: string) => void,
): Promise<RepoActivity> {
  const since = new Date(startMs).toISOString();
  const q = (extra: string): string => (extra ? `&${extra}` : "");

  onProgress("Fetching repository and activity…");
  const [repo, issueRows, pullRows, commitRows] = await Promise.all([
    ghJson(`/repos/${repoSlug}`),
    ghJson(
      `/repos/${repoSlug}/issues?state=all&since=${encodeURIComponent(since)}&sort=updated&direction=desc&per_page=${MAX_ISSUES}`,
    ),
    ghJson(`/repos/${repoSlug}/pulls?state=all&sort=updated&direction=desc&per_page=${MAX_PULLS}`),
    ghJson(
      `/repos/${repoSlug}/commits?since=${encodeURIComponent(since)}&until=${encodeURIComponent(new Date(endMs).toISOString())}&per_page=${MAX_COMMITS}`,
    ),
  ]);

  onProgress("Fetching deployments, alerts, and discussions…");
  // Optional sections: anything other than a missing connection is a skip —
  // the report notes coverage rather than failing.
  const skipped: string[] = [];
  const optional = async (path: string, label: string): Promise<Record<string, unknown>[] | null> => {
    try {
      const out = await ghJson(path);
      return Array.isArray(out) ? out : null;
    } catch (err) {
      if (err instanceof ConnectionRequired) throw err;
      skipped.push(label);
      return null;
    }
  };
  const [deployRows, alertRows, discussionRows] = await Promise.all([
    optional(`/repos/${repoSlug}/deployments?per_page=30`, "deployments"),
    optional(`/repos/${repoSlug}/dependabot/alerts?state=open&per_page=20`, "Dependabot alerts"),
    optional(`/repos/${repoSlug}/discussions?per_page=20`, "discussions"),
  ]);

  const issues = ((issueRows.data ?? issueRows) as GhIssue[])
    .filter((i) => !i.pull_request && inRange(i.updated_at, startMs, endMs))
    .slice(0, MAX_ISSUES);
  const pulls = ((pullRows.data ?? pullRows) as GhPull[])
    .filter((p) => inRange(p.updated_at, startMs, endMs))
    .slice(0, MAX_PULLS);
  const commits = ((commitRows.data ?? commitRows) as GhCommit[]).slice(0, MAX_COMMITS);

  return {
    repo: repo as unknown as GhRepo,
    issues,
    pulls,
    commits,
    deployments: ((deployRows ?? []) as unknown as GhDeployment[]).filter((d) =>
      inRange(d.created_at, startMs, endMs),
    ),
    alerts: (alertRows ?? []) as unknown as GhAlert[],
    discussions: ((discussionRows ?? []) as unknown as GhDiscussion[]).filter((d) =>
      inRange(d.updated_at, startMs, endMs),
    ),
    skipped,
  };
}

// ---------------------------------------------------------------------------
// The report itself (LLM gateway, streamed)
// ---------------------------------------------------------------------------

const firstLine = (message: string | undefined): string => (message ?? "").split("\n")[0] ?? "";
const shortSha = (sha: string | undefined): string => (sha ?? "").slice(0, 7);
const login = (u: { login?: string } | null | undefined): string => u?.login ?? "someone";
const titleOf = (text: string): string => text.slice(0, TITLE_CAP);

function buildDigest(
  repoSlug: string,
  startISO: string,
  endISO: string,
  a: RepoActivity,
): Record<string, unknown> {
  // `YYYY-MM-DD` inputs → UTC milliseconds at day boundaries (the asana-report rule).
  const startMs = Date.parse(`${startISO}T00:00:00.000Z`);
  const endMs = Date.parse(`${endISO}T23:59:59.999Z`) + 1;
  const contributors = [
    ...new Set([
      ...a.commits.map((c) => c.author?.login ?? c.commit?.author?.name ?? "unknown"),
      ...a.pulls.map((p) => login(p.user)),
      ...a.issues.map((i) => login(i.user)),
    ]),
  ].sort();

  return {
    repository: {
      name: a.repo.full_name ?? repoSlug,
      description: a.repo.description ?? undefined,
      stars: a.repo.stargazers_count,
      openIssuesAndPulls: a.repo.open_issues_count,
      lastPush: a.repo.pushed_at,
    },
    range: { start: startISO, end: endISO },
    contributors,
    commits: a.commits.map((c) => ({
      sha: shortSha(c.sha),
      author: c.author?.login ?? c.commit?.author?.name ?? "unknown",
      date: c.commit?.author?.date,
      message: firstLine(c.commit?.message).slice(0, MESSAGE_CAP),
    })),
    commitCountMayBeCapped: a.commits.length >= MAX_COMMITS,
    pullRequests: {
      seen: a.pulls.length,
      listMayBeCapped: a.pulls.length >= MAX_PULLS,
      opened: a.pulls.filter((p) => inRange(p.created_at, startMs, endMs)).map((p) => ({
        number: p.number,
        title: titleOf(p.title),
        author: login(p.user),
        draft: p.draft === true,
        merged: Boolean(p.merged_at),
        closed: Boolean(p.closed_at),
      })),
    },
    issues: {
      seen: a.issues.length,
      listMayBeCapped: a.issues.length >= MAX_ISSUES,
      opened: a.issues.filter((i) => inRange(i.created_at, startMs, endMs)).map((i) => ({
        number: i.number,
        title: titleOf(i.title),
        author: login(i.user),
        closed: Boolean(i.closed_at),
      })),
      closedInRange: a.issues.filter((i) => inRange(i.closed_at, startMs, endMs)).length,
    },
    deployments: a.deployments.map((d) => ({
      environment: d.environment,
      sha: shortSha(d.sha),
      by: login(d.creator),
      at: d.created_at,
    })),
    openDependabotAlerts: a.alerts.map((al) => ({
      number: al.number,
      severity: al.severity,
      summary: al.security_advisory?.summary,
    })),
    discussions: a.discussions.map((d) => ({
      number: d.number,
      title: titleOf(d.title),
      author: login(d.user),
    })),
    sectionsUnavailable: a.skipped.length > 0 ? a.skipped : undefined,
  };
}

const REPORT_SYSTEM_PROMPT = [
  "You are a repository activity reporter. You are given a JSON digest of GitHub",
  "activity for one repository over a date range: commits, pull requests, issues,",
  "deployments, open Dependabot alerts, and discussions.",
  "",
  "Write a crisp activity report in markdown-lite with exactly these sections:",
  "a one-paragraph `## Summary`; `## Highlights` (the most consequential changes,",
  "as short bold-led bullets); `## Code changes` (what commits and pull requests",
  "built, fixed, or changed, and by whom); `## Issues & discussions` (new, closed,",
  "and still-open threads worth attention); and `## Risks & loose ends` (draft or",
  "stalled pull requests, unanswered issues, open security alerts — omit the",
  "section if none).",
  "",
  "Use only facts in the digest — never invent activity, names, or dates. If little",
  "happened, say so plainly rather than padding. Refer to issues and pull requests",
  "by number and title.",
].join("\n");

/**
 * Split an SSE body into records (blank-line separated) and hand each to `onRecord`.
 * The gateway's native surface frames replies as `event: delta` `{text}` records,
 * then `event: done` (or `event: error`).
 */
async function readSse(body: ReadableStream<Uint8Array>, onRecord: (record: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      onRecord(buf.slice(0, sep));
      buf = buf.slice(sep + 2);
    }
  }
}

async function generateReportMarkdown(
  digest: Record<string, unknown>,
  onDelta: (text: string) => void,
): Promise<string> {
  const res = await fetch("/_api/llm/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      system: REPORT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(digest) }],
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(`the LLM request failed (${res.status}): ${err?.error?.message ?? res.statusText}`);
  }

  let accumulated = "";
  let stopReason = "";
  await readSse(res.body, (record) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of record.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const parsed = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    if (event === "delta") {
      const text = String(parsed.text ?? "");
      accumulated += text;
      onDelta(text);
    } else if (event === "done") {
      stopReason = String(parsed.stopReason ?? "");
    } else if (event === "error") {
      throw new Error(String(parsed.message ?? "stream error"));
    }
  });
  if (stopReason.includes("max_tokens")) {
    throw new Error("the report was cut short by the model's output cap — try a shorter range");
  }
  return accumulated;
}

// ---------------------------------------------------------------------------
// Injection-safe markdown (the asana-report renderer: textContent only)
// ---------------------------------------------------------------------------

function renderInline(target: HTMLElement, text: string): void {
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const token = m[0];
    const idx = m.index ?? 0;
    if (idx > last) target.append(text.slice(last, idx));
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      target.append(code);
    } else if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      target.append(strong);
    } else {
      const close = token.indexOf("](");
      const href = token.slice(close + 2, -1);
      if (href.startsWith("https://")) {
        const a = document.createElement("a");
        a.href = href;
        a.textContent = token.slice(1, close);
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        target.append(a);
      } else {
        target.append(token);
      }
    }
    last = idx + token.length;
  }
  if (last < text.length) target.append(text.slice(last));
}

function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        body.push(lines[i]!);
        i++;
      }
      i++;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = body.join("\n");
      pre.append(code);
      frag.append(pre);
      continue;
    }
    if (line.startsWith("- ")) {
      const ul = document.createElement("ul");
      while (i < lines.length && lines[i]!.startsWith("- ")) {
        const li = document.createElement("li");
        renderInline(li, lines[i]!.slice(2));
        ul.append(li);
        i++;
      }
      frag.append(ul);
      continue;
    }
    if (/^#{1,6} /.test(line)) {
      const p = document.createElement("p");
      p.className = "md-heading";
      renderInline(p, line.replace(/^#{1,6} /, ""));
      frag.append(p);
      i++;
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.startsWith("```") &&
      !lines[i]!.startsWith("- ") &&
      !/^#{1,6} /.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    const p = document.createElement("p");
    renderInline(p, para.join("\n"));
    frag.append(p);
  }
  return frag;
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

const whoamiEl = document.querySelector<HTMLParagraphElement>("#whoami")!;
const genForm = document.querySelector<HTMLFormElement>("#gen-form")!;
const repoInput = document.querySelector<HTMLInputElement>("#repo-input")!;
const repoList = document.querySelector<HTMLDataListElement>("#repo-list")!;
const daysSel = document.querySelector<HTMLSelectElement>("#days-sel")!;
const genBtn = document.querySelector<HTMLButtonElement>("#gen-btn")!;
const genStatus = document.querySelector<HTMLParagraphElement>("#gen-status")!;
const connectRow = document.querySelector<HTMLDivElement>("#connect-row")!;
const connectBtn = document.querySelector<HTMLButtonElement>("#connect-btn")!;
const connectStatus = document.querySelector<HTMLParagraphElement>("#connect-status")!;
const reportView = document.querySelector<HTMLElement>("#report-view")!;
const reportTitle = document.querySelector<HTMLHeadingElement>("#report-title")!;
const reportMeta = document.querySelector<HTMLParagraphElement>("#report-meta")!;
const reportBody = document.querySelector<HTMLDivElement>("#report-body")!;

function setStatus(text: string): void {
  genStatus.textContent = text;
}

function showConnectRow(message: string): void {
  connectRow.classList.remove("connected", "blocked");
  connectBtn.hidden = false;
  connectStatus.textContent = message;
  connectRow.hidden = false;
}

/** The healthy state: one small banner, no CTA — the connection is live. */
function showConnectedBanner(): void {
  connectRow.classList.add("connected");
  connectRow.classList.remove("blocked");
  connectBtn.hidden = true;
  connectStatus.textContent = "GitHub connected — pick a repository and a timescale to generate.";
  connectRow.hidden = false;
}

/** The app's binding is not effective — a Connect CTA would only fail, so it
 * stays hidden: an owner or administrator has to fix the app first. */
function showBlockedRow(message: string): void {
  connectRow.classList.add("blocked");
  connectRow.classList.remove("connected");
  connectBtn.hidden = true;
  connectStatus.textContent = message;
  connectRow.hidden = false;
}

/** Who the gateway sees us as (Appendix A.6 `/_api/me`). */
async function loadWhoami(): Promise<void> {
  try {
    const res = await fetch("/_api/me", { headers: { accept: "application/json" } });
    if (res.status === 401) {
      whoamiEl.innerHTML = `Not signed in — <a href="/">sign in</a> to continue.`;
      return;
    }
    if (!res.ok) return;
    const me = (await res.json()) as { user?: { displayName?: string } };
    whoamiEl.textContent = me.user?.displayName ? `Signed in as ${me.user.displayName}` : "Signed in.";
  } catch {
    /* offline / local vite dev */
  }
}

// --- connect (the user's GitHub connection) -----------------------------------

/**
 * A generation paused on `connection_required` resumes here after the consent
 * popup completes — the retry is the app's decision, never the platform's.
 */
let pendingResume: { repoSlug: string; days: number } | null = null;

/**
 * The boot-time connection check — the platform's read-only status route.
 * It answers Helix's own row state with no vendor call, so the app shows the
 * right panel without a wasted 403 probe.
 */
async function connectionState(): Promise<
  "connected" | "not_connected" | "not_available" | "signed_out" | "unknown"
> {
  try {
    const res = await fetch(`/_api/connections/${PROVIDER_REF}/status`);
    if (res.status === 401) return "signed_out";
    if (!res.ok) return "unknown";
    const body = (await res.json()) as { status?: string };
    if (
      body.status === "connected" ||
      body.status === "not_connected" ||
      body.status === "not_available"
    ) {
      return body.status;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function loadRepoSuggestions(): Promise<void> {
  try {
    const res = await ghJson("/user/repos?sort=pushed&direction=desc&per_page=100");
    repoList.innerHTML = "";
    for (const row of (Array.isArray(res) ? res : []) as GhRepo[]) {
      const opt = document.createElement("option");
      opt.value = row.full_name ?? "";
      repoList.append(opt);
    }
  } catch {
    // Suggestions are a convenience — a typed owner/repo works without them.
  }
}

async function doConnect(): Promise<void> {
  connectBtn.disabled = true;
  connectStatus.textContent = "Opening the GitHub consent popup…";
  try {
    if (!window.helix?.connect) {
      connectStatus.textContent =
        "The connect helper is not available — open this app through the platform (it is injected from the manifest's shim grant).";
      return;
    }
    const result = await window.helix.connect(PROVIDER_REF);
    switch (result.outcome) {
      case "connected":
      case "already_connected": {
        showConnectedBanner();
        connectBtn.disabled = false;
        await loadRepoSuggestions();
        if (pendingResume) {
          const resume = pendingResume;
          pendingResume = null;
          repoInput.value = resume.repoSlug;
          daysSel.value = String(resume.days);
          void runGeneration();
        }
        return;
      }
      case "denied":
        connectStatus.textContent = "You declined at GitHub's consent screen — connect to generate reports.";
        break;
      case "cancelled":
        connectStatus.textContent = "The popup closed without completing — connect to generate reports.";
        break;
      case "timeout":
        connectStatus.textContent = "The consent attempt timed out — try again.";
        break;
      case "blocked":
        connectStatus.textContent = "The browser refused the popup — allow popups for this site and try again.";
        break;
      case "signin_required":
        connectStatus.textContent = "Sign in to the app first, then connect again.";
        break;
      default:
        connectStatus.textContent = `Connect failed (platform error${result.reason ? `: ${result.reason}` : ""}).`;
    }
  } finally {
    connectBtn.disabled = false;
  }
}
connectBtn.addEventListener("click", () => void doConnect());

// --- the generate flow ----------------------------------------------------------

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

genForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runGeneration();
});

async function runGeneration(): Promise<void> {
  const repoSlug = repoInput.value.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const days = Number(daysSel.value);
  if (!REPO_PATTERN.test(repoSlug)) {
    setStatus("Pick or type a repository as owner/repo.");
    return;
  }

  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;

  genBtn.disabled = true;
  reportView.hidden = true;
  connectRow.hidden = true;
  try {
    const activity = await collectActivity(repoSlug, startMs, endMs, setStatus);

    const startISO = new Date(startMs).toISOString().slice(0, 10);
    const endISO = new Date(endMs).toISOString().slice(0, 10);
    const digest = buildDigest(repoSlug, startISO, endISO, activity);

    setStatus(
      `Generating the report with ${MODEL} (${activity.commits.length} commits, ` +
        `${activity.pulls.length} pull requests, ${activity.issues.length} issues)…`,
    );
    reportView.hidden = false;
    reportTitle.textContent = `Activity: ${activity.repo.full_name ?? repoSlug}`;
    reportMeta.textContent = `${startISO} → ${endISO} · generating…`;
    reportBody.replaceChildren();

    const markdown = await generateReportMarkdown(digest, (delta) => {
      // Live render: only completed markdown blocks re-parse cleanly, so the
      // stream renders as plain text and the final pass renders markdown.
      reportBody.textContent += delta;
    });

    reportBody.replaceChildren(renderMarkdown(markdown));
    reportMeta.textContent = `${startISO} → ${endISO} · ${MODEL}`;
    setStatus(
      activity.skipped.length
        ? `Done — sections unavailable at the vendor: ${activity.skipped.join(", ")}.`
        : "Done.",
    );
  } catch (err) {
    if (err instanceof ConnectionRequired) {
      pendingResume = { repoSlug, days };
      showConnectRow(
        "Your GitHub connection is needed to read this repository — connect, and the report resumes automatically.",
      );
      setStatus("");
    } else {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  } finally {
    genBtn.disabled = false;
  }
}

// --- boot -----------------------------------------------------------------------

/**
 * The boot panel: one status read decides the connection state up front —
 * connected (banner, suggestions load), not_connected (CTA), not_available
 * (blocked banner — the binding needs an approval), signed_out (CTA with
 * sign-in-first wording), or an unreadable status, which falls back to the
 * lazy discovery path (a real call failing `connection_required`).
 */
async function initConnection(): Promise<void> {
  const state = await connectionState();
  switch (state) {
    case "connected":
      showConnectedBanner();
      await loadRepoSuggestions();
      return;
    case "not_connected":
      showConnectRow(
        "Connect your GitHub account to generate reports — a popup asks GitHub for read access, and the platform stores the token server-side.",
      );
      return;
    case "not_available":
      showBlockedRow(
        "This app's GitHub binding isn't active yet — the app's owner or an administrator has to fix that first.",
      );
      return;
    case "signed_out":
      showConnectRow("Sign in first — then connect GitHub to generate reports.");
      return;
    case "unknown":
      // Fall through to the lazy path: the first real call will say.
      return;
  }
}

void loadWhoami();
void initConnection();
