import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProviderMetadata } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { ProvidersPage } from "../pages/admin/ProvidersPage";
import { App } from "../App";
import { AuthProvider } from "../auth/AuthProvider";
import { setToken, clearToken } from "../auth/tokenStore";

/**
 * Provider administration list (`/admin/providers`, I-02 T-0026): the env
 * badges + filter, the persistent callback hint served at runtime with a
 * working copy action, the import card's mount point, and criterion 13's
 * refresh cadence (30 s while visible, paused hidden, refreshed on return;
 * stale-kept-on-failure; error without data — never an empty success).
 */

function provider(over: Partial<ProviderMetadata> = {}): ProviderMetadata {
  return {
    id: "a1000000-0000-4000-8000-000000000001",
    ref: "asana",
    kind: "rest-delegated",
    displayName: "Asana",
    authorizeEndpoint: "https://asana.example/oauth/authorize",
    tokenEndpoint: "https://asana.example/oauth/token",
    requestedScopes: ["read:tasks"],
    apiOrigins: ["https://api.asana.example"],
    tokenPlacement: { kind: "header-bearer" },
    env: "prod",
    revision: 1,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...over,
  };
}

const CALLBACK_URL = "https://auth.local.helix.azxlabs.io:8080/connections/callback";

interface ListOpts {
  callbackUrl?: string;
  status?: number;
}

/**
 * Stub the providers GET. `list` is captured by reference: mutate the array to
 * change what the next GET answers. Unrelated URLs hang.
 */
function stubFetch(
  list: ProviderMetadata[],
  opts: ListOpts = {},
): Mock & { calls: Array<{ url: string; init?: RequestInit }> } {
  const impl = vi.fn((url: string, init?: RequestInit) => {
    impl.calls.push({ url, init });
    if (url.endsWith("/api/v1/providers")) {
      const failed = opts.status !== undefined && opts.status >= 400;
      return Promise.resolve({
        ok: !failed,
        status: opts.status ?? 200,
        json: async () =>
          failed
            ? { error: { code: "internal", message: "list exploded" } }
            : { callbackUrl: opts.callbackUrl ?? CALLBACK_URL, providers: list },
      });
    }
    return new Promise(() => {});
  }) as Mock & { calls: Array<{ url: string; init?: RequestInit }> };
  impl.calls = [];
  vi.stubGlobal("fetch", impl);
  return impl;
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

function renderPage() {
  return renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setVisibility("visible");
  clearToken();
});

describe("ProvidersPage list", () => {
  it("renders rows with ref, env badge, kind, destinations, placement, and updated date", async () => {
    stubFetch([provider()]);
    renderPage();
    expect(await screen.findByText("asana")).toBeDefined();
    expect(screen.getByText("PROD")).toBeDefined();
    expect(screen.getByText("rest-delegated")).toBeDefined();
    expect(screen.getByText("Asana")).toBeDefined();
    expect(screen.getByText(/https:\/\/api\.asana\.example/)).toBeDefined();
    expect(screen.getByText(/Authorization: Bearer header/)).toBeDefined();
    // Locale-aware date through toLocaleString — digits and a separator,
    // whatever the environment's locale resolves to.
    expect(screen.getByText(/Updated\s+\d/)).toBeDefined();
  });

  it("filters by environment with the All/Dev/Prod control", async () => {
    const user = userEvent.setup();
    stubFetch([
      provider(),
      provider({
        id: "b1000000-0000-4000-8000-000000000002",
        ref: "asana-dev",
        displayName: "Asana dev",
        env: "dev",
      }),
    ]);
    renderPage();
    expect(await screen.findByText("asana")).toBeDefined();
    expect(screen.getByText("asana-dev")).toBeDefined();

    await user.click(screen.getByRole("radio", { name: "Dev" }));
    expect(screen.getByText("asana-dev")).toBeDefined();
    expect(screen.queryByText(/^asana$/)).toBeNull();

    await user.click(screen.getByRole("radio", { name: "Prod" }));
    expect(screen.getByText("asana")).toBeDefined();
    expect(screen.queryByText("asana-dev")).toBeNull();

    await user.click(screen.getByRole("radio", { name: "All" }));
    expect(screen.getByText("asana")).toBeDefined();
    expect(screen.getByText("asana-dev")).toBeDefined();
  });

  it("shows the empty state, not a blank screen, when nothing is configured", async () => {
    stubFetch([]);
    renderPage();
    expect(await screen.findByText(/No providers yet/)).toBeDefined();
  });

  it("renders the callback hint from the runtime payload with a working copy action", async () => {
    stubFetch([provider()], { callbackUrl: CALLBACK_URL });
    const user = userEvent.setup();
    renderPage();
    // The runtime-served value renders — not a build-time placeholder.
    expect(await screen.findByText(CALLBACK_URL)).toBeDefined();
    expect(screen.getByText(/register this exact value with the vendor/)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Copy callback URL" }));
    // The copied acknowledgement, and the clipboard (user-event's in-memory
    // stub) actually received the runtime value.
    expect(await screen.findByRole("button", { name: "Copied" })).toBeDefined();
    expect(await navigator.clipboard.readText()).toBe(CALLBACK_URL);
  });

  it("holds the import card's mount point as a disabled stub", async () => {
    stubFetch([]);
    renderPage();
    expect(await screen.findByText("Import")).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Import from JSON" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("ProvidersPage refresh failure", () => {
  it("keeps loaded rows with a stale indication when a refresh fails", async () => {
    stubFetch([provider()]);
    renderPage();
    expect(await screen.findByText("asana")).toBeDefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: { code: "internal", message: "refetch failed" } }),
        }),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    // The rows stay, and the failure is announced — never an empty success.
    expect(await screen.findByText(/Couldn't refresh/)).toBeDefined();
    expect(screen.getByText("asana")).toBeDefined();
  });

  it("shows an error, not an empty list, when the first load fails", async () => {
    stubFetch([], { status: 500 });
    renderPage();
    expect(await screen.findByText(/Couldn't load providers/)).toBeDefined();
    expect(screen.queryByText(/No providers yet/)).toBeNull();
  });
});

describe("ProvidersPage refresh cadence (criterion 13)", () => {
  it("ticks every 30 s while visible, pauses while hidden, refetches on return", async () => {
    vi.useFakeTimers();
    const impl = stubFetch([provider()]);
    renderPage();
    // The initial page-entry fetch: settle it fully — the rendered card is
    // the proof the stub answered, so the baseline below counts it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });
    expect(screen.getByText("asana")).toBeDefined();
    const gets = () => impl.calls.filter((c) => (c.init?.method ?? "GET") === "GET").length;
    const afterEntry = gets();

    // Two visible ticks, 30 s apart.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(gets()).toBe(afterEntry + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(gets()).toBe(afterEntry + 2);

    // Hidden: the interval pauses — minutes pass, nothing fetches.
    act(() => setVisibility("hidden"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(gets()).toBe(afterEntry + 2);

    // Return: refreshed.
    act(() => setVisibility("visible"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(gets()).toBe(afterEntry + 3);
  });
});

describe("Providers wiring (nav + RequireAdmin)", () => {
  const AUTH_CONFIG = {
    issuer: "https://idp.test",
    cliClientId: "azx-cli",
    webClientId: "azx-portal-web",
  };

  const ADMIN = {
    sub: "alice@azx.dev",
    via: "oidc",
    isAdmin: true,
    canSearchDirectory: true,
  };
  const NON_ADMIN = {
    sub: "bob@azx.dev",
    via: "oidc",
    isAdmin: false,
    canSearchDirectory: true,
  };

  function stubApi(me: typeof ADMIN | typeof NON_ADMIN): void {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => me });
        }
        if (url.endsWith("/api/v1/auth/config")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => AUTH_CONFIG });
        }
        if (url.endsWith("/api/v1/config")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ appPublicBase: "https://apps.example.com" }),
          });
        }
        if (url.includes("/api/v1/apps")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => [] });
        }
        if (url.endsWith("/api/v1/providers")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ callbackUrl: CALLBACK_URL, providers: [] }),
          });
        }
        return new Promise(() => {});
      }),
    );
  }

  it("shows the Providers nav item for an admin", async () => {
    stubApi(ADMIN);
    setToken("test-token");
    renderWithProviders(
      <AuthProvider>
        <App />
      </AuthProvider>,
      { route: "/admin/providers" },
    );
    // The nav item and the page title share the word; one or more must render.
    expect((await screen.findAllByText("Providers")).length).toBeGreaterThan(0);
    expect(await screen.findByText(/No providers yet/)).toBeDefined();
  });

  it("shows neither the nav item nor the route to a non-admin", async () => {
    stubApi(NON_ADMIN);
    setToken("test-token");
    renderWithProviders(
      <AuthProvider>
        <App />
      </AuthProvider>,
      { route: "/admin/providers" },
    );
    await screen.findByText("Apps"); // workspace nav rendered
    await screen.findByText(/requires the platform-admin role/); // route blocked
    expect(screen.queryByText("Providers")).toBeNull(); // no nav item either
    expect(screen.queryByText(/No providers yet/)).toBeNull();
  });
});
