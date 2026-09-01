import "./style.css";

/**
 * Fetch-proxy tire-kicker (docs/features/fetch-proxy.md). Four probes against
 * the GitHub API, each exercising a different slice of the capability:
 *
 *   1. explicit proxy path        — the path-prefix contract (§3.1)
 *   2. explicit proxy, auth-only  — proves server-side secret injection (§5)
 *   3. native fetch(absolute)     — the transparent shim rewriting fetch (§3.2)
 *   4. raw XMLHttpRequest         — the shim covering XHR (what axios uses)
 *
 * GitHub is the ideal target: a Personal Access Token is two clicks to make,
 * the API works keyless (60 req/hr) AND authenticated (5000), and the
 * difference is *observable* — so you can watch the injected token take effect.
 */

const API = "https://api.github.com";

type Status = "ok" | "denied" | "blocked" | "error";
interface ProbeResult {
  status: Status;
  detail: string;
}

const LABEL: Record<Status, string> = {
  ok: "OK",
  denied: "DENIED",
  blocked: "CSP-BLOCKED",
  error: "ERROR",
};

function rateText(json: { rate?: { limit?: number; remaining?: number } }): string {
  const r = json.rate ?? {};
  return `limit ${r.limit ?? "?"}, remaining ${r.remaining ?? "?"}`;
}

/** 1 — explicit proxy path to a keyless endpoint. */
async function probeProxyRate(): Promise<ProbeResult> {
  try {
    const res = await fetch(`/_api/fetch/${API}/rate_limit`);
    if (res.status === 403)
      return { status: "denied", detail: "403 — grant capabilities.fetch.origins for api.github.com" };
    if (res.status === 503)
      return { status: "denied", detail: "503 — fetch capability not configured (is helix-egress up?)" };
    if (!res.ok) return { status: "error", detail: `HTTP ${res.status}` };
    return { status: "ok", detail: rateText(await res.json()) };
  } catch (e) {
    return { status: "error", detail: String(e) };
  }
}

/** 2 — explicit proxy to an auth-only endpoint: the injection proof. */
async function probeProxyUser(): Promise<ProbeResult> {
  try {
    const res = await fetch(`/_api/fetch/${API}/user`);
    if (res.status === 401)
      return { status: "denied", detail: "401 — no token injected yet; bind a `github` connection secret" };
    if (res.status === 403)
      return { status: "denied", detail: "403 — api.github.com is not a proxied origin yet" };
    if (!res.ok) return { status: "error", detail: `HTTP ${res.status}` };
    const u = (await res.json()) as { login?: string; name?: string };
    return { status: "ok", detail: `injected — authenticated as @${u.login} (${u.name ?? "—"})` };
  } catch (e) {
    return { status: "error", detail: String(e) };
  }
}

/** 3 — native fetch to an ABSOLUTE url: works only if the shim rewrites it. */
async function probeShimFetch(): Promise<ProbeResult> {
  try {
    const res = await fetch(`${API}/rate_limit`);
    if (!res.ok) return { status: "error", detail: `HTTP ${res.status}` };
    return { status: "ok", detail: `shim rewrote fetch() · ${rateText(await res.json())}` };
  } catch {
    return { status: "blocked", detail: "connect-src 'self' blocked it — enable the shim to rewrite native fetch()" };
  }
}

/** 4 — raw XHR to an ABSOLUTE url: the transport axios defaults to. */
function probeShimXhr(): Promise<ProbeResult> {
  return new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", `${API}/rate_limit`);
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300)
          return resolve({ status: "error", detail: `HTTP ${xhr.status}` });
        try {
          resolve({ status: "ok", detail: `shim rewrote XHR · ${rateText(JSON.parse(xhr.responseText))}` });
        } catch {
          resolve({ status: "error", detail: "unparseable response" });
        }
      };
      xhr.onerror = () =>
        resolve({ status: "blocked", detail: "blocked — enable the shim (it patches XHR.open, so axios works too)" });
      xhr.send();
    } catch (e) {
      resolve({ status: "error", detail: String(e) });
    }
  });
}

function render(id: string, result: ProbeResult): void {
  const out = document.querySelector<HTMLElement>(`#${id} .out`);
  if (!out) return;
  out.className = `out ${result.status}`;
  out.innerHTML = `<span class="badge">${LABEL[result.status]}</span><span>${result.detail}</span>`;
}

async function runAll(): Promise<void> {
  for (const id of ["probe-proxy-rate", "probe-proxy-user", "probe-shim-fetch", "probe-shim-xhr"]) {
    const out = document.querySelector<HTMLElement>(`#${id} .out`);
    if (out) {
      out.className = "out pending";
      out.textContent = "running…";
    }
  }
  render("probe-proxy-rate", await probeProxyRate());
  render("probe-proxy-user", await probeProxyUser());
  render("probe-shim-fetch", await probeShimFetch());
  render("probe-shim-xhr", await probeShimXhr());
}

/** Show who the gateway sees us as (Appendix A.6 `/_api/me`). */
async function loadWhoami(): Promise<void> {
  const el = document.querySelector<HTMLParagraphElement>("#whoami");
  if (!el) return;
  try {
    const res = await fetch("/_api/me", { headers: { accept: "application/json" } });
    if (res.status === 401) {
      el.innerHTML = `Not signed in — <a href="/">sign in</a> to continue.`;
      return;
    }
    if (!res.ok) {
      el.textContent = "Browsing as a guest.";
      return;
    }
    const me = (await res.json()) as { user?: { displayName?: string } };
    el.textContent = me.user?.displayName ? `Signed in as ${me.user.displayName}` : "Signed in.";
  } catch {
    /* offline / dev */
  }
}

document.querySelector<HTMLButtonElement>("#run-btn")?.addEventListener("click", () => void runAll());
void loadWhoami();
void runAll();
