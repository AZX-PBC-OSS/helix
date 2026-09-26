import "./style.css";

/**
 * Asana Activity Report — a platform example (ADR-0031 delegated connections).
 *
 * Three capabilities cooperate:
 *   - **Delegated connection** — `window.helix.connect("asana")` consents inside
 *     a user gesture; provider-bound calls through `/_api/fetch` get the user's
 *     access token injected server-side (the app never sees it).
 *   - **LLM gateway** — `POST /_api/llm/chat` streams a report from the
 *     activity digest; the model allowlist lives in the manifest.
 *   - **Shared app-data** — finished reports land at `report:<ts>-<rand>` keys,
 *     listable and readable by anyone who passes the app's gate. Reading needs
 *     no Asana connection at all.
 */

const PROVIDER_REF = "asana";
const ASANA_API = "https://app.asana.com";
const MODEL = "gpt-5-nano";
const REPORT_PREFIX = "report:";

/** Safety rails on the Asana crawl — a demo, not a warehouse job. */
const MAX_TASKS = 100;
const STORY_PAGE = 100;
/** Global minimum spacing between Asana story calls (~130/min, under the free-tier ceiling). */
const ASANA_MIN_INTERVAL_MS = 450;
const MAX_ACTIVITY_ENTRIES = 400;
const COMMENT_TEXT_CAP = 280;
const MARKDOWN_VALUE_CAP = 60_000; // the platform caps a shared value at 64 KiB

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
 * One delegated Asana GET through the fetch proxy. The proxy answers
 * provider-shaped errors as JSON `{code, message}` instead of an upstream
 * response — mapped to typed errors the UI can act on.
 */
async function asanaJson(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`/_api/fetch/${ASANA_API}${path}`);
  if (res.status !== 200) {
    const body = (await res.json().catch(() => null)) as { code?: string } | null;
    if (res.status === 403 && body?.code === "connection_required") {
      throw new ConnectionRequired(PROVIDER_REF);
    }
    if (res.status === 403 && body?.code === "forbidden") {
      throw new Error("the Asana origin binding is not approved yet");
    }
    if (res.status === 502 || res.status === 503) {
      throw new Error("the platform could not reach Asana — is helix-egress running?");
    }
    throw new Error(`Asana request failed (${res.status}${body?.code ? ` ${body.code}` : ""})`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Page through an Asana list endpoint (cursor pagination via `offset`) up to
 * `cap` records. The `next_page.offset` token is opaque — always round-trip it
 * encoded.
 */
async function asanaList(path: string, cap: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let offset: string | undefined;
  do {
    const url =
      path +
      (path.includes("?") ? "&" : "?") +
      "limit=100" +
      (offset ? `&offset=${encodeURIComponent(offset)}` : "");
    const page = await asanaJson(url);
    const data = (page.data ?? []) as Record<string, unknown>[];
    out.push(...data);
    offset = (page.next_page as { offset?: string } | undefined)?.offset;
  } while (offset && out.length < cap);
  return out.slice(0, cap);
}

// ---------------------------------------------------------------------------
// The Asana activity crawl
// ---------------------------------------------------------------------------

interface AsanaWorkspace {
  gid: string;
  name: string;
}

interface AsanaProject {
  gid: string;
  name: string;
  archived?: boolean | null;
}

interface AsanaTask {
  gid: string;
  name: string;
  created_at?: string;
  completed?: boolean;
  completed_at?: string | null;
}

interface AsanaStory {
  created_at: string;
  resource_subtype: string;
  text?: string | null;
  created_by?: { name?: string } | null;
}

interface ActivityEntry {
  at: string;
  user: string;
  task: string;
  kind: string;
  text?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `comment_added` → `comment`; anything else passes through as snake_case. */
function storyKind(story: AsanaStory): string {
  if (story.resource_subtype === "comment_added") return "comment";
  return story.resource_subtype;
}

function storyUser(story: AsanaStory): string {
  return story.created_by?.name ?? "someone";
}

/**
 * The activity record for one project over [startMs, endMs): the project's
 * tasks plus each task's stories (comments and the system feed — completions,
 * assignments, due-date changes), filtered to the range. Stories are fetched
 * through one global pacer so a full crawl stays under Asana's per-minute
 * request ceiling.
 */
async function collectActivity(
  projectGid: string,
  startMs: number,
  endMs: number,
  onProgress: (line: string) => void,
): Promise<{ tasks: AsanaTask[]; entries: ActivityEntry[] }> {
  onProgress("Fetching the project's tasks…");
  const taskFields = "name,created_at,completed,completed_at,completed_by.name,assignee.name,modified_at";
  const taskRows = await asanaList(`/api/1.0/tasks?project=${projectGid}&opt_fields=${taskFields}`, MAX_TASKS);
  const tasks: AsanaTask[] = taskRows.map((t) => t as unknown as AsanaTask);

  const entries: ActivityEntry[] = [];
  let inRange = 0;
  let fetched = 0;
  let nextAllowedAt = 0;

  const queue = [...tasks];
  const worker = async (): Promise<void> => {
    for (;;) {
      const task = queue.shift();
      if (!task) return;
      try {
        const path = `/api/1.0/tasks/${task.gid}/stories?opt_fields=created_at,resource_subtype,text,created_by.name`;
        const stories = (await asanaList(path, STORY_PAGE)) as unknown as AsanaStory[];
        for (const story of stories) {
          const at = Date.parse(story.created_at);
          if (Number.isNaN(at) || at < startMs || at >= endMs) continue;
          inRange++;
          if (entries.length >= MAX_ACTIVITY_ENTRIES) continue;
          const text = story.resource_subtype === "comment_added" ? (story.text ?? "") : undefined;
          entries.push({
            at: story.created_at,
            user: storyUser(story),
            task: task.name,
            kind: storyKind(story),
            ...(text ? { text: text.slice(0, COMMENT_TEXT_CAP) } : {}),
          });
        }
      } catch {
        // One task's stories failing must not kill the run — the report notes coverage.
      }
      fetched++;
      onProgress(`Reading activity… ${fetched}/${tasks.length} tasks (${inRange} in range)`);
      // The pacer is global across the workers.
      const wait = nextAllowedAt - Date.now();
      nextAllowedAt = Math.max(nextAllowedAt, Date.now()) + ASANA_MIN_INTERVAL_MS;
      if (wait > 0) await sleep(wait);
    }
  };
  await Promise.all(Array.from({ length: 3 }, () => worker()));

  entries.sort((a, b) => a.at.localeCompare(b.at));
  return { tasks, entries };
}

// ---------------------------------------------------------------------------
// The report itself (LLM gateway, streamed)
// ---------------------------------------------------------------------------

function buildDigest(
  project: AsanaProject,
  startISO: string,
  endISO: string,
  crawl: { tasks: AsanaTask[]; entries: ActivityEntry[] },
): Record<string, unknown> {
  const users = [...new Set(crawl.entries.map((e) => e.user))].sort();
  return {
    project: { name: project.name, gid: project.gid },
    range: { start: startISO, end: endISO },
    tasksSeen: crawl.tasks.length,
    taskCreatedInRange: crawl.tasks.filter((t) => {
      if (!t.created_at) return false;
      const at = Date.parse(t.created_at);
      return at >= startMsOf(startISO) && at < endMsOf(endISO);
    }).length,
    taskCompletedInRange: crawl.tasks.filter((t) => {
      if (!t.completed_at) return false;
      const at = Date.parse(t.completed_at);
      return at >= startMsOf(startISO) && at < endMsOf(endISO);
    }).length,
    activeUsers: users,
    activityEntries: crawl.entries.length,
    truncated: crawl.entries.length >= MAX_ACTIVITY_ENTRIES,
    activity: crawl.entries,
  };
}

/** `YYYY-MM-DD` local-date inputs → UTC milliseconds at day boundaries. */
function startMsOf(dateISO: string): number {
  return Date.parse(`${dateISO}T00:00:00.000Z`);
}
function endMsOf(dateISO: string): number {
  return Date.parse(`${dateISO}T23:59:59.999Z`) + 1;
}

const REPORT_SYSTEM_PROMPT = [
  "You are an agile project reporter. You are given a JSON digest of Asana activity",
  "for one project over a date range: each activity entry has a timestamp, the person,",
  "the task, a kind (comment, marked_complete, assigned, due_date_changed, …) and, for",
  "comments, the comment text.",
  "",
  "Write a crisp activity report in markdown-lite with exactly these sections:",
  "a one-paragraph `## Summary`; `## Highlights` (the most consequential activity, as",
  "short bold-led bullets); `## Who did what` (per-person tallies of comments and key",
  "actions); `## Timeline` (when activity clustered, day by day); and `## Risks & loose",
  "ends` (stalled threads, unanswered asks, missed due dates — omit the section if none).",
  "",
  "Use only facts in the digest — never invent activity, names, or dates. If little",
  "happened, say so plainly rather than padding. Refer to tasks by name.",
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
// Shared app-data: report persistence (no Asana connection needed to read)
// ---------------------------------------------------------------------------

interface ReportRecord {
  id: string;
  projectName: string;
  projectGid: string;
  rangeStart: string;
  rangeEnd: string;
  generatedAt: string;
  model: string;
  markdown: string;
}

/** Chronological keys: zero-padded epoch seconds + a random suffix, `report:`-prefixed. */
function newReportKey(): string {
  const secs = String(Math.floor(Date.now() / 1000)).padStart(10, "0");
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `${REPORT_PREFIX}${secs}-${rand}`;
}

/** Create-if-absent under a fresh chronological key; returns the saved record with its id. */
async function saveReport(record: Omit<ReportRecord, "id">): Promise<ReportRecord> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = newReportKey();
    const res = await fetch(`/_api/data/shared/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-none-match": "*" },
      body: JSON.stringify({ ...record, id: key }),
    });
    if (res.status === 412) continue; // key collision — new suffix, try again
    if (res.status === 429) throw new Error("the app's daily write budget is exhausted");
    if (!res.ok) throw new Error(`saving the report failed (${res.status})`);
    return { ...record, id: key };
  }
  throw new Error("saving the report kept colliding — try again");
}

interface ReportKeyRow {
  key: string;
  version: string;
  updatedAt: string;
}

async function listReportKeys(): Promise<ReportKeyRow[]> {
  const out: ReportKeyRow[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL("/_api/data/shared", location.origin);
    url.searchParams.set("prefix", REPORT_PREFIX);
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url);
    if (res.status === 403) throw new Error("this app is not granted the report list verb");
    if (!res.ok) throw new Error(`listing reports failed (${res.status})`);
    const page = (await res.json()) as { keys: ReportKeyRow[]; nextCursor?: string };
    out.push(...(page.keys ?? []));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

async function getReport(key: string): Promise<ReportRecord | null> {
  const res = await fetch(`/_api/data/shared/${key}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`reading ${key} failed (${res.status})`);
  const parsed = (await res.json()) as Partial<ReportRecord>;
  if (typeof parsed.markdown !== "string" || typeof parsed.projectName !== "string") return null;
  return parsed as ReportRecord;
}

// ---------------------------------------------------------------------------
// Injection-safe markdown (the helix-help renderer: textContent only)
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
const wspSel = document.querySelector<HTMLSelectElement>("#wsp-sel")!;
const projSel = document.querySelector<HTMLSelectElement>("#proj-sel")!;
const startInput = document.querySelector<HTMLInputElement>("#start-date")!;
const endInput = document.querySelector<HTMLInputElement>("#end-date")!;
const genBtn = document.querySelector<HTMLButtonElement>("#gen-btn")!;
const genStatus = document.querySelector<HTMLParagraphElement>("#gen-status")!;
const connectRow = document.querySelector<HTMLDivElement>("#connect-row")!;
const connectBtn = document.querySelector<HTMLButtonElement>("#connect-btn")!;
const connectStatus = document.querySelector<HTMLParagraphElement>("#connect-status")!;
const reportView = document.querySelector<HTMLElement>("#report-view")!;
const reportTitle = document.querySelector<HTMLHeadingElement>("#report-title")!;
const reportMeta = document.querySelector<HTMLParagraphElement>("#report-meta")!;
const reportBody = document.querySelector<HTMLDivElement>("#report-body")!;
const reportsList = document.querySelector<HTMLDivElement>("#reports-list")!;
const reportDetail = document.querySelector<HTMLElement>("#report-detail")!;
const detailTitle = document.querySelector<HTMLHeadingElement>("#detail-title")!;
const detailMeta = document.querySelector<HTMLParagraphElement>("#detail-meta")!;
const detailBody = document.querySelector<HTMLDivElement>("#detail-body")!;
const closeDetail = document.querySelector<HTMLButtonElement>("#close-detail")!;
const tabGenerate = document.querySelector<HTMLButtonElement>("#tab-generate")!;
const tabReports = document.querySelector<HTMLButtonElement>("#tab-reports")!;
const viewGenerate = document.querySelector<HTMLElement>("#view-generate")!;
const viewReports = document.querySelector<HTMLElement>("#view-reports")!;

const fmt = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function setStatus(text: string): void {
  genStatus.textContent = text;
}

function showConnectRow(message: string): void {
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

// --- tabs -------------------------------------------------------------------

function selectTab(which: "generate" | "reports"): void {
  const gen = which === "generate";
  tabGenerate.classList.toggle("active", gen);
  tabReports.classList.toggle("active", !gen);
  viewGenerate.hidden = !gen;
  viewReports.hidden = gen;
  if (!gen) void refreshReports();
}
tabGenerate.addEventListener("click", () => selectTab("generate"));
tabReports.addEventListener("click", () => selectTab("reports"));

// --- connect (the user's Asana connection; generation-only) ------------------

/**
 * A generation paused on `connection_required` resumes here after the consent
 * popup completes — the retry is the app's decision, never the platform's.
 */
let pendingResume = false;

async function doConnect(): Promise<void> {
  connectBtn.disabled = true;
  connectStatus.textContent = "Opening the Asana consent popup…";
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
        connectRow.hidden = true;
        connectBtn.disabled = false;
        if (pendingResume) {
          pendingResume = false;
          void runGeneration();
        }
        return;
      }
      case "denied":
        connectStatus.textContent = "You declined at Asana's consent screen — connect to generate reports.";
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

// --- pickers -----------------------------------------------------------------

const workspaces: AsanaWorkspace[] = [];
const projects = new Map<string, AsanaProject[]>();

async function loadWorkspaces(): Promise<void> {
  wspSel.disabled = true;
  try {
    const rows = (await asanaList("/api/1.0/workspaces", 100)) as unknown as AsanaWorkspace[];
    workspaces.length = 0;
    workspaces.push(...rows);
    wspSel.innerHTML = "";
    if (!workspaces.length) {
      wspSel.innerHTML = `<option value="">No workspaces your token can see</option>`;
      return;
    }
    for (const wsp of workspaces) {
      const opt = document.createElement("option");
      opt.value = wsp.gid;
      opt.textContent = wsp.name;
      wspSel.append(opt);
    }
    await loadProjects(wspSel.value);
  } catch (err) {
    wspSel.innerHTML = `<option value="">Workspace list unavailable</option>`;
    setStatus(
      err instanceof ConnectionRequired
        ? "Connect your Asana account to list workspaces."
        : String(err instanceof Error ? err.message : err),
    );
    showConnectRow("Connect your Asana account to pick a project — reading saved reports needs no connection.");
    if (err instanceof ConnectionRequired) pendingResume = false;
  } finally {
    wspSel.disabled = false;
  }
}

async function loadProjects(wspGid: string): Promise<void> {
  projSel.innerHTML = `<option value="">Loading…</option>`;
  projSel.disabled = true;
  try {
    let rows = projects.get(wspGid);
    if (!rows) {
      const fetched = (await asanaList(
        `/api/1.0/workspaces/${wspGid}/projects?opt_fields=name,archived,modified_at`,
        200,
      )) as unknown as AsanaProject[];
      rows = fetched.filter((p) => !p.archived).sort((a, b) => a.name.localeCompare(b.name));
      projects.set(wspGid, rows);
    }
    projSel.innerHTML = "";
    if (!rows.length) {
      projSel.innerHTML = `<option value="">No projects in this workspace</option>`;
      return;
    }
    for (const project of rows) {
      const opt = document.createElement("option");
      opt.value = project.gid;
      opt.textContent = project.name;
      projSel.append(opt);
    }
  } catch (err) {
    projSel.innerHTML = `<option value="">Project list unavailable</option>`;
    if (err instanceof ConnectionRequired) showConnectRow("Connect your Asana account to pick a project.");
    else setStatus(String(err instanceof Error ? err.message : err));
  } finally {
    projSel.disabled = false;
  }
}
wspSel.addEventListener("change", () => void loadProjects(wspSel.value));

// --- the generate flow --------------------------------------------------------

function dateInputs(): { startISO: string; endISO: string } | null {
  if (!startInput.value || !endInput.value) {
    setStatus("Pick both a start and an end date.");
    return null;
  }
  if (startMsOf(startInput.value) >= endMsOf(endInput.value)) {
    setStatus("The range's start must come before its end.");
    return null;
  }
  return { startISO: startInput.value, endISO: endInput.value };
}

genForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runGeneration();
});

async function runGeneration(): Promise<void> {
  const range = dateInputs();
  const project = projects.get(wspSel.value)?.find((p) => p.gid === projSel.value);
  if (!range) return;
  if (!project) {
    setStatus("Pick a workspace and a project first (connecting Asana loads the lists).");
    return;
  }

  genBtn.disabled = true;
  reportView.hidden = true;
  connectRow.hidden = true;
  try {
    const crawl = await collectActivity(
      project.gid,
      startMsOf(range.startISO),
      endMsOf(range.endISO),
      setStatus,
    );

    setStatus(`Generating the report with ${MODEL} (${crawl.entries.length} activity entries)…`);
    const digest = buildDigest(project, range.startISO, range.endISO, crawl);
    reportView.hidden = false;
    reportTitle.textContent = `Activity: ${project.name}`;
    reportMeta.textContent = `${range.startISO} → ${range.endISO} · generating…`;
    reportBody.replaceChildren();

    const markdown = await generateReportMarkdown(digest, (delta) => {
      // Live render: only completed markdown blocks re-parse cleanly, so the
      // stream renders as plain text and the final pass renders markdown.
      reportBody.textContent += delta;
    });

    reportBody.replaceChildren(renderMarkdown(markdown.slice(0, MARKDOWN_VALUE_CAP)));
    reportMeta.textContent = `${range.startISO} → ${range.endISO} · ${MODEL}`;

    setStatus("Saving the report to shared storage…");
    await saveReport({
      projectName: project.name,
      projectGid: project.gid,
      rangeStart: range.startISO,
      rangeEnd: range.endISO,
      generatedAt: new Date().toISOString(),
      model: MODEL,
      markdown: markdown.slice(0, MARKDOWN_VALUE_CAP),
    });
    reportMeta.textContent = `${range.startISO} → ${range.endISO} · ${MODEL} · saved`;
    setStatus("Report saved — find it under Reports (readable by anyone with app access).");
  } catch (err) {
    if (err instanceof ConnectionRequired) {
      pendingResume = true;
      showConnectRow(
        "Your Asana connection is needed to read this project's activity — connect, and the report resumes automatically.",
      );
      setStatus("");
    } else {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  } finally {
    genBtn.disabled = false;
  }
}

// --- the reports view (works without any Asana connection) --------------------

function metaLine(r: ReportRecord): string {
  return `${r.projectName} · ${r.rangeStart} → ${r.rangeEnd} · ${fmt(r.generatedAt)} · ${r.model}`;
}

function renderReportRow(r: ReportRecord): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "report-row";
  const name = document.createElement("strong");
  name.textContent = r.projectName;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `${r.rangeStart} → ${r.rangeEnd} · ${fmt(r.generatedAt)}`;
  row.append(name, meta);
  row.addEventListener("click", () => {
    detailTitle.textContent = r.projectName;
    detailMeta.textContent = metaLine(r);
    detailBody.replaceChildren(renderMarkdown(r.markdown));
    reportDetail.hidden = false;
    reportsList.hidden = true;
  });
  return row;
}

async function refreshReports(): Promise<void> {
  reportDetail.hidden = true;
  reportsList.hidden = false;
  reportsList.replaceChildren("Loading saved reports…");
  try {
    const keys = await listReportKeys();
    if (!keys.length) {
      reportsList.replaceChildren("No saved reports yet — generate the first one.");
      return;
    }
    const rows: HTMLElement[] = [];
    for (const { key } of keys.reverse()) {
      const record = await getReport(key);
      if (record) rows.push(renderReportRow(record));
    }
    reportsList.replaceChildren(...(rows.length ? rows : ["No readable reports yet."]));
  } catch (err) {
    reportsList.replaceChildren(String(err instanceof Error ? err.message : err));
  }
}
closeDetail.addEventListener("click", () => {
  reportDetail.hidden = true;
  reportsList.hidden = false;
});

// --- boot ---------------------------------------------------------------------

function initDates(): void {
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  endInput.value = today.toISOString().slice(0, 10);
  startInput.value = weekAgo.toISOString().slice(0, 10);
}

initDates();
void loadWhoami();
void loadWorkspaces();
