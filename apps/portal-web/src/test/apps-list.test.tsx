import { describe, expect, it, vi, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppListItem } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { AppsListPage } from "../pages/AppsListPage";
import { AuthProvider } from "../auth/AuthProvider";
import { DeployProvider } from "../modals/DeployContext";
import { HelpProvider } from "../modals/HelpContext";

/**
 * These deliberately use a non-dev domain everywhere. The bug this guards is a
 * prebuilt bundle showing `*.local.helix.azxlabs.io:8080` in production, so a
 * test that asserted the dev default would pass on the broken code.
 */
const APPS_BASE = "https://apps.example.com";

function makeApp(
  slug: string,
  displayName: string,
  live: boolean,
  url?: string,
  extra: Partial<AppListItem> = {},
): AppListItem {
  return {
    id: crypto.randomUUID(),
    slug,
    displayName,
    visibility: { mode: "internal" },
    currentVersionId: live ? crypto.randomUUID() : null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    versionCount: live ? 1 : 0,
    lastDeployAt: live ? new Date().toISOString() : null,
    liveVersionNumber: live ? 1 : null,
    latestPreviewNumber: null,
    ...(url ? { url } : {}),
    ...extra,
  };
}

/** Column order in `AppsTable`: App, Owner, Visibility, Status, … */
const OWNER_CELL = 1;

const APPS = [
  makeApp("cost-explorer", "Cost Explorer", true, "https://cost-explorer.apps.example.com"),
  makeApp("standup", "Standup", false, "https://standup.apps.example.com"),
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Route the calls this page makes, plus the deployment config. Anything else
 * (auth config, health) stays pending, as in the other suites — note that means a
 * route left out of here hangs rather than 404s.
 *
 * `apps` may be a single list (both scopes see it) or one list per scope, which is
 * what the scope cases below assert on. The requested scope is read off the query
 * string, so a page that stopped sending it would fail rather than silently pass.
 */
type ScopedApps = AppListItem[] | { mine: AppListItem[]; all: AppListItem[] };

function stubFetch(
  apps: ScopedApps,
  config: unknown = { appPublicBase: APPS_BASE },
  usage: { byApp: { slug: string; tokens: number; requests: number; costUsd: number }[] } = {
    byApp: [],
  },
) {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      const appsCall = /^\/api\/v1\/apps(\?|$)/.exec(url);
      if (appsCall) {
        const scope = new URL(url, "http://x").searchParams.get("scope") ?? "mine";
        const body = Array.isArray(apps) ? apps : (apps[scope === "all" ? "all" : "mine"] ?? []);
        return Promise.resolve(jsonResponse(body));
      }
      if (url === "/api/v1/config") {
        return config === "pending"
          ? new Promise<Response>(() => {})
          : Promise.resolve(jsonResponse(config));
      }
      if (url.startsWith("/api/v1/gateway/usage")) {
        return Promise.resolve(
          jsonResponse({
            range: "30d",
            series: [],
            totals: { tokensMTD: 0, requestsMTD: 0, costMTD: 0, activeUsers: 0 },
            capabilityMix: [],
            ...usage,
          }),
        );
      }
      if (/\/versions$/.test(url)) return Promise.resolve(jsonResponse([]));
      return new Promise<Response>(() => {}); // auth config, health: pending
    }),
  );
  return seen;
}

function render(route = "/") {
  renderWithProviders(
    <AuthProvider>
      <DeployProvider>
        <HelpProvider>
          <AppsListPage />
        </HelpProvider>
      </DeployProvider>
    </AuthProvider>,
    { route },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("AppsListPage", () => {
  it("renders a row per app from the registry", async () => {
    stubFetch(APPS);
    render();
    expect(await screen.findByText("Cost Explorer")).toBeDefined();
    expect(await screen.findByText("Standup")).toBeDefined();
  });

  /**
   * The host is no longer table text — it was the widest column, saying per row
   * what the name already said. It reaches the reader through the link beside the
   * name instead, so that link's target is what these cases pin.
   */
  it("links each live app at the URL the server computed", async () => {
    stubFetch(APPS);
    render();

    const link = await screen.findByRole("link", {
      name: /open cost-explorer\.apps\.example\.com/i,
    });
    expect(link.getAttribute("href")).toBe("https://cost-explorer.apps.example.com");
  });

  // Standup has no live version, so there is nothing serving to open. Same rule
  // the app's own header follows.
  it("offers no app link for an app that is not live", async () => {
    stubFetch(APPS);
    render();

    await screen.findByText("Standup");
    expect(screen.queryByRole("link", { name: /open standup/i })).toBeNull();
  });

  // An older portal predating AppSchema.url: compose the slug onto the base from
  // /api/v1/config rather than showing nothing.
  it("falls back to the deployment base when an app carries no url", async () => {
    stubFetch([makeApp("legacy", "Legacy", true)]);
    render();

    const link = await screen.findByRole("link", { name: /open legacy\.apps\.example\.com/i });
    expect(link.getAttribute("href")).toBe("https://legacy.apps.example.com");
  });

  it("renders no app link at all while the deployment config is in flight", async () => {
    stubFetch([makeApp("legacy", "Legacy", true)], "pending");
    render();

    // The row renders; only the link is withheld — never a guessed domain. Asserts
    // the link's absence, not merely the absence of the dev host: with the host
    // gone from the table text, a substring check would pass on its own.
    expect(await screen.findByText("Legacy")).toBeDefined();
    expect(screen.queryByRole("link", { name: /^open /i })).toBeNull();
    expect(screen.queryByText(/helix\.azxlabs\.io/)).toBeNull();
  });

  it("shows the empty state when the registry is empty", async () => {
    stubFetch([]);
    render();
    expect(await screen.findByText("No apps yet")).toBeDefined();
    // The "served at <slug>.<domain>" hint uses the deployment base.
    expect(screen.getByText(`https://<slug>.apps.example.com`)).toBeDefined();
  });

  it("omits the empty-state URL hint until the deployment config arrives", async () => {
    stubFetch([], "pending");
    render();
    expect(await screen.findByText("No apps yet")).toBeDefined();
    expect(screen.queryByText(/served at/)).toBeNull();
  });

  /**
   * The regression that drove the New app / Deploy split, inherited from
   * `deploy-modal.test.tsx`: registering an app was once only reachable through
   * the deploy modal picker's "nothing found" message, so a single app in the
   * registry hid the only path to a second one anywhere in the UI. The apps page now
   * owns creation, and its button does not care how many apps exist.
   */
  it("keeps app creation reachable when apps already exist", async () => {
    stubFetch(APPS);
    render();

    await userEvent.click(await screen.findByRole("button", { name: /create app/i }));
    // The registration form itself, not a link off to somewhere else.
    expect(await screen.findByRole("textbox", { name: /subdomain/i })).toBeDefined();
  });

  it("opens the create modal from the empty state", async () => {
    stubFetch([]);
    render();

    await userEvent.click(await screen.findByRole("button", { name: /create your first app/i }));
    expect(await screen.findByRole("textbox", { name: /subdomain/i })).toBeDefined();
  });

  it("offers no deploy affordance — deploying belongs to an app's own page", async () => {
    stubFetch(APPS);
    render();

    await screen.findByText("Cost Explorer");
    expect(screen.queryByRole("button", { name: /deploy/i })).toBeNull();
  });

  /**
   * The page used to be two pages: a card grid here and an admin-only table at
   * `/admin/registry`, both rendering the same unscoped `GET /api/v1/apps`. The
   * scope control is that distinction made real.
   */
  describe("scope", () => {
    const MINE = [makeApp("mine-app", "Mine App", true, "https://mine-app.apps.example.com")];
    const THEIRS = [
      ...MINE,
      makeApp("their-app", "Their App", true, "https://their-app.apps.example.com", {
        ownerId: "bob@azx.dev",
        ownerName: "Bob Builder",
        ownerEmail: "bob@azx.dev",
      }),
    ];

    it("lands on the caller's own apps", async () => {
      const seen = stubFetch({ mine: MINE, all: THEIRS });
      render();

      expect(await screen.findByText("Mine App")).toBeDefined();
      expect(screen.queryByText("Their App")).toBeNull();
      expect(seen.some((u) => u.includes("scope=mine"))).toBe(true);
    });

    // Deep-linkable, and where `/admin/registry` now redirects to.
    it("honours ?scope=all from the URL", async () => {
      stubFetch({ mine: MINE, all: THEIRS });
      render("/?scope=all");

      expect(await screen.findByText("Their App")).toBeDefined();
      expect(screen.getByText("Mine App")).toBeDefined();
    });

    it("switches scope from the control, and puts it in the URL", async () => {
      stubFetch({ mine: MINE, all: THEIRS });
      render();
      await screen.findByText("Mine App");

      await userEvent.click(screen.getByRole("radio", { name: "All" }));
      expect(await screen.findByText("Their App")).toBeDefined();
    });

    it("falls back to mine on a scope it does not recognise", async () => {
      stubFetch({ mine: MINE, all: THEIRS });
      render("/?scope=everything");

      expect(await screen.findByText("Mine App")).toBeDefined();
      expect(screen.queryByText("Their App")).toBeNull();
    });

    it("says nothing is registered, not that you have no apps, under scope=all", async () => {
      stubFetch({ mine: [], all: [] });
      render("/?scope=all");

      expect(await screen.findByText("Nothing registered yet")).toBeDefined();
    });
  });

  /**
   * Whose app is this? The question the owner column exists to answer — including
   * for apps the caller does not own, which is why nothing gates these fields.
   */
  describe("owner column", () => {
    it("prefers the captured display name, and shows the address under it", async () => {
      stubFetch([
        makeApp("owned", "Owned", true, "https://owned.apps.example.com", {
          ownerId: "alice@azx.dev",
          ownerName: "Alice Anders",
          ownerEmail: "alice@azx.dev",
        }),
      ]);
      render();

      expect(await screen.findByText("Alice Anders")).toBeDefined();
      expect(screen.getByText("alice@azx.dev")).toBeDefined();
    });

    // Rows predating the display columns: the raw identity is still readable
    // today, and is all there is to show.
    it("falls back to the raw identity when no display claims were captured", async () => {
      stubFetch([
        makeApp("legacy-owner", "Legacy Owner", true, "https://legacy-owner.apps.example.com", {
          ownerId: "someone@azx.dev",
        }),
      ]);
      render();

      expect(await screen.findByText("someone@azx.dev")).toBeDefined();
    });

    // Assert on the owner cell by position rather than counting dashes: other
    // cells are legitimately empty too, and the spend column starts out that way
    // until its own query lands.
    it("renders a dash for an app with no recorded owner", async () => {
      stubFetch([makeApp("ownerless", "Ownerless", true, "https://ownerless.apps.example.com")]);
      render();

      const row = (await screen.findByText("Ownerless")).closest("tr");
      expect(row).not.toBeNull();
      const owner = within(row as HTMLElement).getAllByRole("cell")[OWNER_CELL];
      expect(owner?.textContent).toBe("—");
    });
  });

  /**
   * The column the card grid could not have had: its sparkline plotted deploy
   * cadence from version timestamps because there was no metering API yet.
   */
  it("joins spend onto each row by slug", async () => {
    stubFetch(
      APPS,
      { appPublicBase: APPS_BASE },
      {
        byApp: [{ slug: "cost-explorer", tokens: 1000, requests: 4, costUsd: 1.25 }],
      },
    );
    render();

    expect(await screen.findByText("$1.25")).toBeDefined();
  });

  /**
   * The bug the projected fields fixed. The old table called `appStatus` with no
   * version rows to read, so it could only ever answer "live" or "empty" — an app
   * with a build waiting on a promote reported as never deployed.
   */
  it("distinguishes a pending preview from an app that has never deployed", async () => {
    stubFetch([
      makeApp("waiting", "Waiting", false, "https://waiting.apps.example.com", {
        versionCount: 1,
        latestPreviewNumber: 3,
        lastDeployAt: new Date().toISOString(),
      }),
      makeApp("untouched", "Untouched", false, "https://untouched.apps.example.com"),
    ]);
    render();

    await screen.findByText("Waiting");
    expect(screen.getByText("v3 awaiting promote")).toBeDefined();
    expect(screen.getByText("Preview")).toBeDefined();
    // The state the old table collapsed this one into.
    expect(screen.getByText("Not deployed")).toBeDefined();
  });

  /**
   * The agent handoff replaced four stat cards, and unconditionally: the skill is
   * re-copied whenever you start an app or a fresh agent session, so it is not
   * first-run content that earns its place only on an empty registry.
   */
  describe("agent handoff", () => {
    // A current portal always sends the size caps; the skill can't render without
    // them, so a config missing them is a *disabled* copy button, not a default.
    const FULL_CONFIG = { appPublicBase: APPS_BASE, deployMaxFileMb: 12, deployMaxBundleMb: 60 };

    it("hands out the skill with apps already in the registry", async () => {
      stubFetch(APPS, FULL_CONFIG);
      render();

      await screen.findByText("Cost Explorer");
      const copy = await screen.findByRole("button", { name: /copy agent instructions/i });
      await waitFor(() => expect(copy).toHaveProperty("disabled", false));
    });

    it("hands out the same skill on an empty registry", async () => {
      stubFetch([], FULL_CONFIG);
      render();

      await screen.findByText("No apps yet");
      const copy = await screen.findByRole("button", { name: /copy agent instructions/i });
      await waitFor(() => expect(copy).toHaveProperty("disabled", false));
    });

    /**
     * Rendered without the deployment config the skill carries `{{PLACEHOLDER}}`
     * hosts and no size caps, and what leaves this button is acted on directly by
     * a coding agent — so it stays disabled rather than handing over a guess. An
     * older portal that omits the caps lands in the same state.
     */
    it("withholds the skill until the deployment config arrives", async () => {
      stubFetch(APPS, "pending");
      render();

      const copy = await screen.findByRole("button", { name: /copy agent instructions/i });
      expect(copy).toHaveProperty("disabled", true);
    });

    it("opens the onboarding modal without a trip to the sidebar", async () => {
      stubFetch(APPS, FULL_CONFIG);
      render();

      expect(screen.queryByText("The four steps")).toBeNull();
      await userEvent.click(await screen.findByRole("button", { name: /how to develop/i }));
      expect(await screen.findByText("The four steps")).toBeDefined();
    });
  });
});
