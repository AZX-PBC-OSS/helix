import "./style.css";

/**
 * Direct third-party fetch — the deliberate counterpoint to `chatbot`, which
 * routes everything through the gateway. This app calls the public GitHub API
 * STRAIGHT from the browser, so the platform's static CSP (`connect-src 'self'`)
 * blocks it until an admin grants the origin.
 *
 * The flow this showcases (docs/design/approvals.md §6.2):
 *   1. The fetch is blocked → the browser auto-POSTs a violation to the edge's
 *      `report-uri` (`/_csp-report`) — no app code needed for that.
 *   2. The violation surfaces on the portal Violations screen as a one-click
 *      "request this origin".
 *   3. An admin approves the request → `capabilities.externalOrigins` gains the
 *      origin → the edge widens this app's `connect-src` within ~1 min.
 *   4. The same fetch now succeeds — with NO change to this code or a redeploy.
 *
 * It also reads `/_api/me` to show who the gateway sees, exercising the M3 auth
 * session on a (non-public) app host.
 */

const API_ORIGIN = "https://api.github.com";

const whoamiEl = document.querySelector<HTMLParagraphElement>("#whoami")!;
const form = document.querySelector<HTMLFormElement>("#repo-form")!;
const input = document.querySelector<HTMLInputElement>("#repo-input")!;
const btn = document.querySelector<HTMLButtonElement>("#fetch-btn")!;
const result = document.querySelector<HTMLElement>("#result")!;

/** Show who the gateway sees us as (Appendix A.6 `/_api/me`). */
async function loadWhoami(): Promise<void> {
  try {
    const res = await fetch("/_api/me", { headers: { accept: "application/json" } });
    if (res.status === 401) {
      whoamiEl.innerHTML = `Not signed in — <a href="/">sign in</a> to continue.`;
      return;
    }
    if (res.status === 403 || res.status === 404) {
      // Public app (no session) or gateway not wired in this dev edge.
      whoamiEl.textContent = "Browsing as a guest.";
      return;
    }
    if (!res.ok) return;
    const me = (await res.json()) as { user?: { displayName?: string } };
    whoamiEl.textContent = me.user?.displayName
      ? `Signed in as ${me.user.displayName}`
      : "Signed in.";
  } catch {
    /* offline / dev — leave it as-is */
  }
}

function render(html: string, kind: "ok" | "blocked" | "error"): void {
  result.hidden = false;
  result.className = `result ${kind}`;
  result.innerHTML = html;
}

interface Repo {
  full_name: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  html_url: string;
}

async function fetchStars(repo: string): Promise<void> {
  btn.disabled = true;
  render(`Fetching <code>${API_ORIGIN}/repos/${repo}</code>…`, "ok");
  try {
    const res = await fetch(`${API_ORIGIN}/repos/${repo}`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (res.status === 404) {
      render(`No repo <code>${repo}</code> — try <code>owner/name</code>.`, "error");
      return;
    }
    if (!res.ok) {
      render(`GitHub returned ${res.status}. (Unauthenticated calls are rate-limited.)`, "error");
      return;
    }
    const r = (await res.json()) as Repo;
    render(
      `<a href="${r.html_url}" target="_blank" rel="noopener"><strong>${r.full_name}</strong></a>
       <p class="desc">${r.description ?? ""}</p>
       <ul class="stats">
         <li>★ <strong>${r.stargazers_count.toLocaleString()}</strong> stars</li>
         <li>⑂ <strong>${r.forks_count.toLocaleString()}</strong> forks</li>
         <li>● <strong>${r.open_issues_count.toLocaleString()}</strong> open issues</li>
       </ul>`,
      "ok",
    );
  } catch {
    // A CSP block (or any network failure) rejects with a TypeError. The most
    // likely cause here is the policy blocking api.github.com — surface the fix.
    render(
      `<strong>Blocked.</strong> The app's Content-Security-Policy didn't allow a request to
       <code>${API_ORIGIN}</code>, so the browser refused it. The platform just recorded a CSP
       violation.
       <p class="hint">Fix it without touching this app: open the portal's
       <strong>Violations</strong> screen, click <em>“Request this origin”</em> for
       <code>${API_ORIGIN}</code>, and have an admin approve it. The edge widens this app's
       <code>connect-src</code> within ~1&nbsp;min — then this button just works.</p>`,
      "blocked",
    );
  } finally {
    btn.disabled = false;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const repo = input.value.trim().replace(/^https?:\/\/github\.com\//, "");
  if (repo) void fetchStars(repo);
});

void loadWhoami();
