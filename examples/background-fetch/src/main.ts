// Background fetch: start batches of `jobs:fetch` jobs, close the tab, and
// come back (here or on another device) to finished results.
//
// The page never calls an outside origin itself. Each job is one GET the
// platform makes on the user's behalf, through the app's fetch grants, after
// the request that started it has ended. The page's only job is to remember
// which jobs it started (in the user's private store) and poll them.

import "./style.css";
import { onExchange, submitFetch, whoami, type Exchange } from "./api";
import {
  STATUS_UNSUBMITTED,
  isFinished,
  loadRuns,
  matchesExpectation,
  newRun,
  refreshJob,
  removeRun,
  runFinished,
  saveRun,
  submitJob,
  type JobSpec,
  type Run,
  type RunJob,
  type RunKind,
} from "./runs";

// ---------------------------------------------------------------- batches

const CITIES: [string, number, number][] = [
  ["London", 51.51, -0.13],
  ["New York", 40.71, -74.01],
  ["Tokyo", 35.68, 139.69],
  ["São Paulo", -23.55, -46.63],
  ["Nairobi", -1.29, 36.82],
  ["Sydney", -33.87, 151.21],
  ["Reykjavík", 64.15, -21.94],
  ["Mumbai", 19.08, 72.88],
];

function weatherSpecs(): JobSpec[] {
  return CITIES.map(([name, lat, lon]) => ({
    label: name,
    url:
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=3`,
  }));
}

const SLOW_JOBS = 8;
const SLOW_SECONDS = 10;

function slowSpecs(): JobSpec[] {
  return Array.from({ length: SLOW_JOBS }, (_, i) => ({
    label: `Slow job ${i + 1}`,
    url: `https://httpbin.org/delay/${SLOW_SECONDS}?job=${i + 1}`,
  }));
}

const HTTPBIN = "https://httpbin.org";

function labSpecs(): JobSpec[] {
  const ok = { status: ["succeeded"], code: null };
  const failed = (code: string) => ({ status: ["failed"], code });
  return [
    { label: "Control: a small JSON document", url: `${HTTPBIN}/json`, expect: ok },
    {
      label: "Cancel a 10-second job right after submitting it",
      url: `${HTTPBIN}/delay/10?case=cancel`,
      cancel: true,
      // Cancellation is a request, not a guarantee: a job that finishes first keeps its result.
      expect: { status: ["cancelled", "succeeded"], code: "cancelled" },
    },
    {
      label: "Upstream answers 500",
      url: `${HTTPBIN}/status/500`,
      expect: failed("upstream_error"),
    },
    {
      label: "Upstream redirects (redirects are not followed)",
      url: `${HTTPBIN}/redirect-to?url=${encodeURIComponent(`${HTTPBIN}/json`)}`,
      expect: failed("upstream_error"),
    },
    {
      label: "Upstream returns HTML, not JSON",
      url: `${HTTPBIN}/html`,
      expect: failed("result_invalid"),
    },
    {
      label: "Upstream returns about 1 MB of JSON (limit 64 KiB)",
      url: "https://jsonplaceholder.typicode.com/photos",
      expect: failed("result_too_large"),
    },
    {
      label: "Origin not in the app's fetch grants",
      url: "https://example.com/",
      expect: failed("outbound_forbidden"),
    },
  ];
}

const BATCHES: Record<RunKind, { title: string; specs: () => JobSpec[] }> = {
  weather: { title: "Weather snapshot", specs: weatherSpecs },
  slow: { title: "Slow batch", specs: slowSpecs },
  lab: { title: "Failure lab", specs: labSpecs },
};

// ---------------------------------------------------------------- state

let runs: Run[] = [];
let signedOut = false;
let activeTab: RunKind = "weather";
/** Jobs that were unfinished when the page loaded. */
const unfinishedAtLoad = new Set<string>();
let finishedWhileAway = 0;
/** Run cards the user has open. Rendering rebuilds the cards, so this keeps them open. */
const openRuns = new Set<string>();
let firstTickDone = false;
/** Set by a 429 or 503 on submit: hold further submissions until then. */
let submitHoldUntil = 0;
const SUBMIT_HOLD_MS = 15_000;

// ---------------------------------------------------------------- DOM helper

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

// ---------------------------------------------------------------- engine

let ticking = false;
let again = false;
let delay = 2_000;
let timer: number | undefined;

/** Run a tick now, or right after the current one finishes. */
function kick(): void {
  if (ticking) {
    again = true;
    return;
  }
  window.clearTimeout(timer);
  void tick();
}

async function tick(): Promise<void> {
  ticking = true;
  let anyChange = false;
  try {
    for (const run of runs) {
      if (runFinished(run)) continue;
      let changed = false;
      for (const job of run.jobs) {
        if (isFinished(job)) continue;
        if (job.jobId === null) {
          if (Date.now() < submitHoldUntil) continue;
          const outcome = await submitJob(job);
          if (outcome === "signed-out") {
            signedOut = true;
            return;
          }
          if (outcome === "retry-later") submitHoldUntil = Date.now() + SUBMIT_HOLD_MS;
          changed = true;
          continue;
        }
        const wasUnfinished = !isFinished(job);
        if (await refreshJob(job)) changed = true;
        if (wasUnfinished && isFinished(job) && !firstTickDone && unfinishedAtLoad.has(job.key)) {
          finishedWhileAway++;
        }
      }
      if (changed) {
        anyChange = true;
        await saveRun(run);
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    firstTickDone = true;
    ticking = false;
    render();
    delay = anyChange ? 2_000 : Math.min(delay * 1.5, 10_000);
    if (again) {
      again = false;
      kick();
    } else if (!signedOut && runs.some((r) => !runFinished(r))) {
      timer = window.setTimeout(() => void tick(), delay);
    }
  }
}

async function startRun(kind: RunKind): Promise<void> {
  const batch = BATCHES[kind];
  const run = newRun(kind, batch.title, batch.specs());
  // Persist before submitting: the record holds every retry key and body.
  if (!(await saveRun(run))) {
    alert("Could not save the run to your data store, so nothing was submitted.");
    return;
  }
  runs.unshift(run);
  openRuns.add(run.id);
  delay = 2_000;
  render();
  kick();
}

// ---------------------------------------------------------------- rendering

const STATUS_ICON: Record<string, string> = {
  [STATUS_UNSUBMITTED]: "◌",
  queued: "○",
  running: "◐",
  succeeded: "●",
  failed: "✕",
  crashed: "✕",
  cancelled: "⊘",
  expired: "◍",
  gone: "◍",
};

function jobRow(job: RunJob, showResult: boolean): HTMLElement {
  const status = job.submitError ? "refused" : job.status;
  const detail =
    job.submitError ??
    job.error?.code ??
    job.progress ??
    (job.cancelSent ? "cancel requested" : "");
  const verdict = matchesExpectation(job);
  const row = h(
    "li",
    { class: `job s-${status}` },
    h("span", { class: "icon", "aria-hidden": "true" }, STATUS_ICON[status] ?? "?"),
    h("span", { class: "label" }, job.label),
    h("span", { class: "status" }, status),
    h("span", { class: "detail" }, detail),
  );
  if (job.expect) {
    const want = job.expect.code
      ? `${job.expect.status.join(" or ")} · ${job.expect.code}`
      : job.expect.status.join(" or ");
    row.append(
      h(
        "span",
        { class: `expect ${verdict === null ? "" : verdict ? "pass" : "fail"}` },
        verdict === null ? `expect ${want}` : verdict ? "✓ as expected" : `✗ expected ${want}`,
      ),
    );
  }
  if (showResult && job.status === "succeeded" && job.result !== undefined) {
    const d = h("details", { class: "result" }, h("summary", {}, "result"));
    d.append(h("pre", {}, JSON.stringify(job.result, null, 2)));
    row.append(d);
  }
  return row;
}

interface Daily {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  weather_code: number[];
}

function weatherWord(code: number): string {
  if (code === 0) return "☀ clear";
  if (code <= 3) return "⛅ cloudy";
  if (code <= 48) return "🌫 fog";
  if (code <= 67) return "🌧 rain";
  if (code <= 77) return "❄ snow";
  if (code <= 82) return "🌦 showers";
  return "⛈ storms";
}

function weatherTable(run: Run): HTMLElement | null {
  const rows = run.jobs.filter((j) => j.status === "succeeded" && j.resultKept);
  if (rows.length === 0) return null;
  const table = h(
    "table",
    { class: "weather" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", {}, "City"),
        h("th", {}, "Today"),
        h("th", {}, "High / low"),
        h("th", {}, "Next two days"),
      ),
    ),
  );
  const body = h("tbody");
  for (const job of rows) {
    const d = (job.result as { daily?: Daily }).daily;
    if (!d) continue;
    const next = d.time
      .slice(1)
      .map((_, i) => `${Math.round(d.temperature_2m_max[i + 1] ?? NaN)}°`)
      .join(" · ");
    body.append(
      h(
        "tr",
        {},
        h("td", {}, job.label),
        h("td", {}, weatherWord(d.weather_code[0] ?? 0)),
        h(
          "td",
          {},
          `${Math.round(d.temperature_2m_max[0] ?? NaN)}° / ${Math.round(d.temperature_2m_min[0] ?? NaN)}°`,
        ),
        h("td", { class: "muted" }, next),
      ),
    );
  }
  table.append(body);
  return table;
}

function runCard(run: Run): HTMLElement {
  const done = run.jobs.filter(isFinished).length;
  const finished = runFinished(run);
  const lab = run.jobs.filter((j) => j.expect);
  const passed = lab.filter((j) => matchesExpectation(j) === true).length;
  const summary =
    run.kind === "lab" && finished
      ? `${passed}/${lab.length} matched`
      : `${done}/${run.jobs.length} done`;
  const when = new Date(run.createdAt).toLocaleString();

  const card = h("details", { class: `run ${finished ? "finished" : "active"}` });
  if (openRuns.has(run.id)) card.setAttribute("open", "");
  card.addEventListener("toggle", () => {
    if (card.open) openRuns.add(run.id);
    else openRuns.delete(run.id);
  });
  const remove = h("button", { type: "button", class: "ghost small" }, "Forget");
  remove.addEventListener("click", (e) => {
    e.preventDefault();
    void removeRun(run).then(() => {
      runs = runs.filter((r) => r !== run);
      render();
    });
  });
  card.append(
    h(
      "summary",
      {},
      h("span", { class: "run-title" }, run.title),
      h("span", { class: "muted" }, when),
      h("span", { class: `chip ${finished ? "" : "live"}` }, summary),
      remove,
    ),
  );
  if (run.kind === "weather") {
    const t = weatherTable(run);
    if (t) card.append(t);
  }
  // The weather table already shows the results; the lab's verdict is the point.
  const showResult = run.kind === "slow";
  card.append(h("ul", { class: "jobs" }, ...run.jobs.map((j) => jobRow(j, showResult))));
  return card;
}

function render(): void {
  const banner = $("banner");
  banner.replaceChildren();
  if (signedOut) {
    banner.append(
      h(
        "p",
        { class: "notice bad" },
        "Your session has ended. ",
        h("a", { href: "/" }, "Reload to sign in again"),
        ".",
      ),
    );
  } else if (finishedWhileAway > 0) {
    banner.append(
      h(
        "p",
        { class: "notice good" },
        `${finishedWhileAway} job${finishedWhileAway === 1 ? "" : "s"} finished while this page was closed.`,
      ),
    );
  }

  const live = runs.some((r) => r.jobs.some((j) => j.jobId !== null && !isFinished(j)));
  const waiting = runs.some((r) => r.jobs.some((j) => j.jobId === null && !isFinished(j)));
  const hint = $("hint");
  hint.replaceChildren();
  if (waiting) {
    hint.append(
      h(
        "p",
        { class: "notice warn" },
        "Some jobs are not submitted yet: the submission window is full. Keep this page open until they are — ",
        "a closed page cannot submit, but reopening it resumes with the same retry keys.",
      ),
    );
  } else if (live) {
    hint.append(
      h(
        "p",
        { class: "notice live" },
        h("strong", {}, "Close this tab now. "),
        "Every job is accepted and runs without it. Come back in a minute, or open this app on another device.",
      ),
    );
  }

  for (const kind of Object.keys(BATCHES) as RunKind[]) {
    $(`tab-${kind}`).setAttribute("aria-selected", String(kind === activeTab));
    $(`panel-${kind}`).hidden = kind !== activeTab;
  }

  const list = $("runs");
  list.replaceChildren(...runs.map(runCard));
  $("runs-empty").hidden = runs.length > 0;
}

// ---------------------------------------------------------------- lab probes

function probeLine(out: HTMLElement, text: string): void {
  out.append(text + "\n");
}

/**
 * Burst malformed submissions until the per-app window refuses one. Each
 * attempt is authorized, so it counts against the window even though the
 * body check rejects it, and no job is created.
 */
async function probeThrottle(): Promise<void> {
  const out = $("probe-out");
  out.replaceChildren();
  probeLine(out, "Sending malformed submissions ({}) until the window says 429…");
  for (let i = 1; i <= 15; i++) {
    const r = await submitFetch("{}", crypto.randomUUID());
    probeLine(out, `#${i}  ${r.status} ${r.code ?? ""}`);
    if (r.status === 429) {
      probeLine(
        out,
        `\nThe window refused attempt ${i}. Nothing was created by the refused attempts. ` +
          "Submissions in the next minute wait and retry with their original keys.",
      );
      submitHoldUntil = Date.now() + 60_000;
      return;
    }
  }
  probeLine(out, "\nNo 429 seen: this deployment's window is larger than 15 per minute.");
}

/** Same key + same bytes recovers the job; same key + different bytes is a 409. */
async function probeRetryKey(): Promise<void> {
  const out = $("probe-out");
  out.replaceChildren();
  const key = crypto.randomUUID();
  const a = JSON.stringify({ url: `${HTTPBIN}/json` });
  const b = JSON.stringify({ url: `${HTTPBIN}/uuid` });
  const show = (label: string, r: Awaited<ReturnType<typeof submitFetch>>) => {
    const id = (r.body as { jobId?: string } | null)?.jobId;
    probeLine(out, `${label}\n   → ${r.status} ${r.code ?? ""}${id ? ` jobId ${id}` : ""}`);
  };
  probeLine(out, `Retry key ${key}\n`);
  show("1. submit body A", await submitFetch(a, key));
  show(
    "2. resend body A with the same key (a retry after a lost reply)",
    await submitFetch(a, key),
  );
  show("3. send body B with the same key", await submitFetch(b, key));
  probeLine(out, "\nExpected: 1 and 2 return the same jobId; 3 is 409 idempotency_conflict.");
}

// ---------------------------------------------------------------- exchange log

const LOG_LIMIT = 60;

function logExchange(e: Exchange): void {
  const log = $("log");
  const time = e.at.toLocaleTimeString();
  const line = `${time}  ${e.method.padEnd(6)} ${e.path}  → ${e.status}${e.code ? ` ${e.code}` : ""}`;
  log.prepend(line + "\n");
  while (log.childNodes.length > LOG_LIMIT) log.lastChild?.remove();
}

// ---------------------------------------------------------------- boot

async function boot(): Promise<void> {
  onExchange(logExchange);

  for (const kind of Object.keys(BATCHES) as RunKind[]) {
    $(`tab-${kind}`).addEventListener("click", () => {
      activeTab = kind;
      render();
    });
    $(`start-${kind}`).addEventListener("click", () => void startRun(kind));
  }
  $("probe-throttle").addEventListener("click", () => void probeThrottle());
  $("probe-retry").addEventListener("click", () => void probeRetryKey());

  const me = await whoami();
  if (me.status === 200) {
    const user = (me.body as { user?: { displayName?: string } }).user;
    $("whoami").textContent = user?.displayName ? `Signed in as ${user.displayName}` : "Signed in";
  }

  const loaded = await loadRuns();
  if (loaded === "signed-out") {
    signedOut = true;
  } else {
    runs = loaded;
    for (const run of runs)
      for (const job of run.jobs) if (!isFinished(job)) unfinishedAtLoad.add(job.key);
    for (const run of runs) if (!runFinished(run)) openRuns.add(run.id);
    const latest = runs[0];
    if (latest) {
      activeTab = latest.kind;
      openRuns.add(latest.id);
    }
  }
  render();
  kick();
}

void boot();
