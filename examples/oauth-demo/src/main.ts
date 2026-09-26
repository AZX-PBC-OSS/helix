import "./style.css";

/**
 * OAuth-connections tire-kicker (docs/features/fetch-proxy.md §Delegated
 * providers). Two probes against the fixture vendor (apps/dev-oauth-vendor):
 *
 *   1. consent      — window.helix.connect() inside the click gesture; the
 *                     result is an outcome, never a throw.
 *   2. delegated    — a provider-bound call through /_api/fetch; the 403
 *                     connection_required / 200 token-injected pair is the
 *                     observable proof.
 */

const PROVIDER_REF = "demo-vendor";
const VENDOR_API = "http://localhost:3003";

type Status = "ok" | "denied" | "error" | "pending";

function render(id: string, status: Status, detail: string): void {
  const out = document.querySelector<HTMLElement>(`#${id} .out`);
  if (!out) return;
  const label: Record<Status, string> = {
    ok: "OK",
    denied: "DENIED",
    error: "ERROR",
    pending: "…",
  };
  out.className = `out ${status === "pending" ? "pending" : status}`;
  out.innerHTML = `<span class="badge">${label[status]}</span><span></span>`;
  out.lastElementChild!.textContent = detail;
}

/** Outcome text for probe 1 — every result is an outcome; the promise never rejects. */
function connectDetail(outcome: string, reason?: string): { status: Status; detail: string } {
  switch (outcome) {
    case "connected":
      return { status: "ok", detail: "connected — consent granted and saved" };
    case "already_connected":
      return { status: "ok", detail: "already connected — the platform never bothered the vendor" };
    case "denied":
      return { status: "denied", detail: "declined at the vendor's consent screen" };
    case "cancelled":
      return { status: "denied", detail: "popup closed without completing" };
    case "timeout":
      return { status: "denied", detail: "five minutes elapsed with the popup open" };
    case "blocked":
      return { status: "denied", detail: "the browser refused the popup — it must be a real user gesture" };
    case "signin_required":
      return { status: "denied", detail: "sign in to the app first, then Connect again" };
    default:
      return { status: "error", detail: `platform error${reason ? ` — ${reason}` : ""}` };
  }
}

/** Probe 1 — consent. Must run inside the click handler (the browser's popup rule). */
async function probeConnect(): Promise<void> {
  render("probe-connect", "pending", "popup open — complete consent in the window…");
  const result = await window.helix.connect(PROVIDER_REF);
  const { status, detail } = connectDetail(result.outcome, result.reason);
  render(
    "probe-connect",
    status,
    `${detail} [outcome: ${result.outcome}${result.attempt ? `, attempt: ${result.attempt.slice(0, 8)}…` : ""}]`,
  );
}

/** Never echo a live token into the DOM — mask to a recognizable prefix. */
function maskToken(token: string): string {
  return token.length > 12 ? `${token.slice(0, 12)}…` : "…";
}

/** Probe 2 — the delegated call: injection is server-side, the echo proves it. */
async function probeCall(): Promise<void> {
  render("probe-call", "pending", "calling through the gateway…");
  try {
    const res = await fetch(`/_api/fetch/${VENDOR_API}/api/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "oauth-demo" }),
    });
    if (res.status === 403) {
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      if (body?.code === "connection_required") {
        render("probe-call", "denied", "403 connection_required — no connection for you yet; Connect first");
        return;
      }
      render("probe-call", "denied", `403 ${body?.code ?? "forbidden"} — is the manifest binding approved?`);
      return;
    }
    if (res.status === 503) {
      render("probe-call", "error", "503 — provider unavailable (is helix-egress up and wired?)");
      return;
    }
    if (!res.ok) {
      render("probe-call", "error", `HTTP ${res.status}`);
      return;
    }
    const echo = (await res.json()) as {
      placement: string;
      headerName: string;
      token: string;
      method: string;
      path: string;
    };
    render(
      "probe-call",
      "ok",
      `token arrived in ${echo.placement === "header-bearer" ? "Authorization: Bearer" : echo.headerName} ` +
        `[${maskToken(echo.token)}] · ${echo.method} ${echo.path}`,
    );
  } catch (e) {
    render("probe-call", "error", String(e));
  }
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

document.querySelector<HTMLButtonElement>("#connect-btn")?.addEventListener("click", () => void probeConnect());
document.querySelector<HTMLButtonElement>("#call-btn")?.addEventListener("click", () => void probeCall());
void loadWhoami();
