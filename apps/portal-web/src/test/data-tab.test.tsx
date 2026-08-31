import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { App, CollectionItem, CollectionSummary } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { AuthProvider } from "../auth/AuthProvider";
import { DataTab } from "../pages/tabs/DataTab";
import { setToken, clearToken } from "../auth/tokenStore";

/**
 * The owner's read side of a write-only collection. Two properties carry most of
 * the weight here: the table is built from columns *derived* from unvalidated,
 * visitor-supplied JSON (so it must survive shapes nobody designed for), and the
 * prod-by-default env filter must never hide rows without saying so.
 */

const APP: App = {
  id: crypto.randomUUID(),
  slug: "waitlist",
  displayName: "Waitlist",
  visibility: { mode: "public" },
  currentVersionId: crypto.randomUUID(),
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  url: "https://waitlist.apps.example.com",
};

const AUTH_CONFIG = { issuer: "https://idp.test", cliClientId: "cli", webClientId: "web" };

let seq = 0;
function item(over: Partial<CollectionItem> = {}): CollectionItem {
  seq += 1;
  return {
    // A real UUID: the response passes through CollectionItemsPageSchema.
    id: crypto.randomUUID(),
    collection: "signups",
    env: "prod",
    userOid: null,
    userName: null,
    userEmail: null,
    userKind: null,
    item: { email: `lead${seq}@example.com`, name: `Lead ${seq}` },
    meta: { ipHash: "abc123" },
    createdAt: new Date().toISOString(),
    ...over,
  };
}

interface Stub {
  index?: CollectionSummary[];
  rows?: CollectionItem[];
  collections?: string[];
  exportHeaders?: Record<string, string>;
  onDelete?: (url: string) => void;
  /** Hold the manifest in flight, or fail it, to exercise the loading gates. */
  manifest?: "pending" | "error";
  /** Make the export reject, e.g. an expired token mid-session. */
  exportStatus?: number;
  /** Hold the export until this resolves, to observe the in-flight button state. */
  exportGate?: Promise<void>;
}

function stubApi(s: Stub = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (url.endsWith("/api/v1/auth/config")) return json(AUTH_CONFIG);
    if (url.endsWith("/api/v1/config")) return json({ appPublicBase: "https://apps.example.com" });
    if (url.endsWith("/api/v1/me")) {
      return json({ sub: "alice@azx.dev", via: "oidc", isAdmin: false, canSearchDirectory: true });
    }
    if (url.includes("/manifest")) {
      if (s.manifest === "pending") return new Promise(() => {});
      if (s.manifest === "error") {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: { code: "internal", message: "manifest down" } }),
        });
      }
      return json({
        app: APP.slug,
        visibility: APP.visibility,
        capabilities: { data: { collections: s.collections ?? ["signups"] } },
      });
    }
    if (url.includes("/export")) {
      if (s.exportGate) {
        return s.exportGate.then(() => ({
          ok: true,
          status: 200,
          text: async () => "id,createdAt\nx,y",
          headers: new Headers(s.exportHeaders ?? {}),
        }));
      }
      if (s.exportStatus) {
        return Promise.resolve({
          ok: false,
          status: s.exportStatus,
          json: async () => ({ error: { code: "forbidden", message: "you do not own this app" } }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => "id,createdAt\nx,y",
        headers: new Headers(s.exportHeaders ?? {}),
      });
    }
    if (init?.method === "DELETE") {
      s.onDelete?.(url);
      return Promise.resolve({ ok: true, status: 204 });
    }
    // `/collections/<name>?…` is the row list; bare `/collections` is the index.
    if (/\/collections\/[^/?]+/.test(url)) {
      const env = new URL(url, "http://x").searchParams.get("env");
      const rows = (s.rows ?? []).filter((r) => !env || r.env === env);
      return json({ rows });
    }
    if (url.includes("/collections")) return json(s.index ?? []);
    return new Promise(() => {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function render() {
  renderWithProviders(
    <AuthProvider>
      <DataTab app={APP} />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("DataTab", () => {
  it("asks for sign-in before fetching anything", async () => {
    const fetchMock = stubApi();
    render();
    expect(await screen.findByText(/sign in to view what this app has collected/i)).toBeDefined();
    // Earn the name: every app-scoped route is bearer-gated, so an ungated query
    // here is a background 401, not a free read. AuthProvider's own calls are
    // expected, hence the filter.
    const appScoped = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/api/v1/apps/"));
    expect(appScoped).toEqual([]);
  });

  it("does not claim there are no collections while the manifest is loading", async () => {
    // The index is the cheaper request, so it lands first. A declared-but-empty
    // collection would otherwise be told to grant a capability it already has.
    setToken("t");
    stubApi({ index: [], collections: ["signups"], manifest: "pending" });
    render();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/this app has no collections/i)).toBeNull();
  });

  it("still works off the index when the manifest fails", async () => {
    // A manifest error must degrade, not spin — and must not accuse a perfectly
    // normal collection of being undeclared.
    setToken("t");
    stubApi({
      manifest: "error",
      index: [{ name: "signups", env: "prod", count: 1, lastAt: new Date().toISOString() }],
      rows: [item()],
    });
    render();
    expect(await screen.findByRole("table")).toBeDefined();
    expect(screen.queryByText(/no longer declared/i)).toBeNull();
  });

  it("renders a column per derived scalar key, namespaced", async () => {
    setToken("t");
    // Values read off the fixture rather than reconstructed — `item()` numbers
    // from a module-level counter, so a literal here breaks when tests are added.
    const rows = [item(), item()];
    stubApi({
      index: [{ name: "signups", env: "prod", count: 2, lastAt: new Date().toISOString() }],
      rows,
    });
    render();
    expect(await screen.findByText("item.email")).toBeDefined();
    expect(screen.getByText("item.name")).toBeDefined();
    const first = rows[0]!.item as { email: string };
    expect(screen.getByText(first.email)).toBeDefined();
  });

  it("survives an item that isn't an object", async () => {
    // `POST /_api/data/collections/:name` takes any JSON body, so a string, a
    // number or null all reach this table. None may blank the page.
    setToken("t");
    stubApi({
      index: [{ name: "signups", env: "prod", count: 3, lastAt: new Date().toISOString() }],
      rows: [item({ item: "just a string" }), item({ item: null }), item({ item: [1, 2] })],
    });
    render();
    // No derived columns are possible, so the table falls back to When + actions
    // and still renders every row.
    expect(await screen.findByRole("table")).toBeDefined();
    expect(screen.queryByText(/item\./)).toBeNull();
    expect(screen.getAllByLabelText("Show raw item")).toHaveLength(3);
  });

  it("renders falsy scalars rather than blanking them", async () => {
    setToken("t");
    stubApi({
      index: [{ name: "signups", env: "prod", count: 1, lastAt: new Date().toISOString() }],
      rows: [item({ item: { subscribed: false, count: 0 } })],
    });
    render();
    expect(await screen.findByText("false")).toBeDefined();
    expect(screen.getByText("0")).toBeDefined();
  });

  it("hides dev rows by default but says how many and offers to show them", async () => {
    // The accepted cost of a prod-first default is that a developer who just
    // tested in dev mode must not conclude their data vanished.
    setToken("t");
    stubApi({
      index: [
        { name: "signups", env: "prod", count: 1, lastAt: new Date().toISOString() },
        { name: "signups", env: "dev", count: 340, lastAt: new Date().toISOString() },
      ],
      rows: [item(), item({ env: "dev", item: { email: "dev@test.io" } })],
    });
    render();

    expect(await screen.findByText(/340 more rows in the other tier/i)).toBeDefined();
    expect(screen.queryByText("dev@test.io")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /show all/i }));
    expect(await screen.findByText("dev@test.io")).toBeDefined();
    // With both tiers on screen the row's tier becomes a column.
    expect(screen.getByText("dev")).toBeDefined();
  });

  it("spans the full table when a row is expanded, in either tier view", async () => {
    // The Env column only exists in the All view, so a constant colSpan is short
    // by one there — and All is exactly where the "Show all" CTA sends the owner.
    // Asserted against the rendered header count so it survives a new column.
    setToken("t");
    stubApi({
      index: [
        { name: "signups", env: "prod", count: 1, lastAt: new Date().toISOString() },
        { name: "signups", env: "dev", count: 1, lastAt: new Date().toISOString() },
      ],
      rows: [item()],
    });
    render();

    const spanOfDetail = () =>
      Number(document.querySelector("tbody tr:nth-child(2) td")?.getAttribute("colspan") ?? "0");
    const headerCount = () => document.querySelectorAll("thead th").length;

    await userEvent.click(await screen.findByLabelText("Show raw item"));
    expect(spanOfDetail()).toBe(headerCount());

    // The row stays expanded across the switch, so the detail cell is still there
    // to measure — now against a header that has gained the Env column.
    await userEvent.click(screen.getByRole("button", { name: /show all/i }));
    expect(await screen.findByText("Env")).toBeDefined();
    expect(spanOfDetail()).toBe(headerCount());
  });

  it("flags a collection the manifest no longer declares", async () => {
    setToken("t");
    stubApi({
      collections: [],
      index: [{ name: "orphaned", env: "prod", count: 4, lastAt: new Date().toISOString() }],
      rows: [item({ collection: "orphaned" })],
    });
    render();
    expect(await screen.findByText(/no longer declared in this app's manifest/i)).toBeDefined();
  });

  it("offers a declared-but-empty collection", async () => {
    setToken("t");
    stubApi({ collections: ["signups"], index: [], rows: [] });
    render();
    expect(await screen.findByText(/nothing collected in prod yet/i)).toBeDefined();
  });

  it("says so when there are no collections at all", async () => {
    setToken("t");
    stubApi({ collections: [], index: [] });
    render();
    expect(await screen.findByText(/this app has no collections/i)).toBeDefined();
  });

  it("warns when the export was capped instead of presenting a short file", async () => {
    setToken("t");
    stubApi({
      index: [{ name: "signups", env: "prod", count: 1, lastAt: new Date().toISOString() }],
      rows: [item()],
      exportHeaders: { "x-helix-export-truncated": "10000" },
    });
    // jsdom has no real download; the anchor click is a no-op we don't assert on.
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    render();
    await userEvent.click(await screen.findByRole("button", { name: /^csv$/i }));
    expect(await screen.findByText(/capped at 10,000 rows/i)).toBeDefined();
  });

  it("reports both caps when both fire", async () => {
    // Row and column caps are independent; a single note slot would have made the
    // later setter win and silently drop the row cap, which is the one that loses
    // data.
    setToken("t");
    stubApi({
      index: [{ name: "signups", env: "prod", count: 1, lastAt: new Date().toISOString() }],
      rows: [item()],
      exportHeaders: {
        "x-helix-export-truncated": "10000",
        "x-helix-export-columns-truncated": "12",
      },
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    render();
    await userEvent.click(await screen.findByRole("button", { name: /^csv$/i }));
    expect(await screen.findByText(/capped at 10,000 rows/i)).toBeDefined();
    expect(screen.getByText(/12 most common fields/i)).toBeDefined();
  });

  it("presents a failed export as a failure, not as a truncation notice", async () => {
    // The owner got no file at all here; a warn-toned footnote in the slot a
    // truncation notice normally occupies reads like the download succeeded.
    setToken("t");
    stubApi({
      index: [{ name: "signups", env: "prod", count: 1, lastAt: new Date().toISOString() }],
      rows: [item()],
      exportStatus: 403,
    });
    render();
    await userEvent.click(await screen.findByRole("button", { name: /^csv$/i }));
    expect(await screen.findByText(/export failed/i)).toBeDefined();
    expect(screen.queryByText(/capped at/i)).toBeNull();
  });

  it("clears an export error when the collection changes", async () => {
    setToken("t");
    stubApi({
      index: [
        { name: "signups", env: "prod", count: 1, lastAt: new Date().toISOString() },
        { name: "feedback", env: "prod", count: 1, lastAt: new Date().toISOString() },
      ],
      collections: ["signups", "feedback"],
      rows: [item()],
      exportStatus: 403,
    });
    render();
    await userEvent.click(await screen.findByRole("button", { name: /^csv$/i }));
    expect(await screen.findByText(/export failed/i)).toBeDefined();

    // A stale "forbidden" pinned across a collection switch would misattribute the
    // failure to the collection now on screen. `names` is sorted, so the tab opens
    // on `feedback` and `signups` is the switch.
    await userEvent.click(screen.getByRole("combobox", { name: /collection/i }));
    await userEvent.click(await screen.findByText(/^signups ·/));
    expect(screen.queryByText(/export failed/i)).toBeNull();
  });

  it("spins only the format being exported, and locks the other", async () => {
    setToken("t");
    let release!: () => void;
    const exportGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubApi({
      index: [{ name: "signups", env: "prod", count: 1, lastAt: new Date().toISOString() }],
      rows: [item()],
      exportGate,
    });
    render();

    const csv = await screen.findByRole("button", { name: /^csv$/i });
    const json = screen.getByRole("button", { name: /^json$/i });
    await userEvent.click(csv);

    expect(csv.hasAttribute("data-loading")).toBe(true);
    // Not merely cosmetic: two concurrent exports would race the note state and
    // double the server's peak memory for a 10,000-row pull.
    expect(json.hasAttribute("data-loading")).toBe(false);
    expect(json.hasAttribute("disabled")).toBe(true);
    release();
  });

  it("erases an item only after the confirm", async () => {
    setToken("t");
    const deletes: string[] = [];
    stubApi({
      index: [{ name: "signups", env: "prod", count: 1, lastAt: new Date().toISOString() }],
      rows: [item()],
      onDelete: (url) => deletes.push(url),
    });
    render();

    await userEvent.click(await screen.findByLabelText("Erase this item"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/cannot be undone/i)).toBeDefined();
    expect(deletes).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole("button", { name: /^erase$/i }));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain("/collections/signups/items/");
  });

  it("shows the raw item and the triage metadata on expand", async () => {
    setToken("t");
    stubApi({
      index: [{ name: "signups", env: "prod", count: 1, lastAt: new Date().toISOString() }],
      rows: [item({ item: { email: "a@b.c", nested: { deep: true } } })],
    });
    render();
    // `nested` earns no column, so the raw view is the only place it survives.
    expect(screen.queryByText(/deep/)).toBeNull();
    await userEvent.click(await screen.findByLabelText("Show raw item"));
    expect(await screen.findByText(/"deep": true/)).toBeDefined();
    expect(screen.getByText(/ipHash/)).toBeDefined();
    expect(screen.getByText("anonymous")).toBeDefined();
  });
});
