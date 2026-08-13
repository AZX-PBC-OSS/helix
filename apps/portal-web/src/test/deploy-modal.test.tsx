import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { App } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { AuthProvider } from "../auth/AuthProvider";
import { setToken, clearToken } from "../auth/tokenStore";
import { DeployModal } from "../modals/DeployModal";

/**
 * The regression that drove the redesign: registering an app was only reachable
 * through the picker's "nothing found" message, so with one app already in the
 * registry there was no path to a second one anywhere in the UI. Step 1 now owns
 * the choice (pick *or* create) and step 2 stays inert until it's made.
 */

const APPS_BASE = "https://apps.example.com";

function makeApp(slug: string, displayName: string): App {
  return {
    id: crypto.randomUUID(),
    slug,
    displayName,
    visibility: { mode: "internal" },
    currentVersionId: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    url: `${APPS_BASE.replace("https://", `https://${slug}.`)}`,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** GET /apps + POST /apps (the create) + the deployment config; the rest hangs. */
function stubFetch(apps: App[]) {
  const created: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/apps" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { slug: string; displayName: string };
        created.push(body);
        return Promise.resolve(jsonResponse(makeApp(body.slug, body.displayName)));
      }
      if (url === "/api/v1/apps") return Promise.resolve(jsonResponse(apps));
      if (url === "/api/v1/config")
        return Promise.resolve(jsonResponse({ appPublicBase: APPS_BASE }));
      return new Promise<Response>(() => {}); // auth config, /me: pending
    }),
  );
  return created;
}

function render(initialSlug?: string) {
  renderWithProviders(
    <AuthProvider>
      <DeployModal opened initialSlug={initialSlug} onClose={() => {}} />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("DeployModal", () => {
  it("offers app registration even when apps already exist", async () => {
    setToken("t");
    stubFetch([makeApp("cost-explorer", "Cost Explorer")]);
    render();

    await userEvent.click(await screen.findByRole("radio", { name: "New app" }));
    // The registration form itself, not a link off to somewhere else.
    expect(await screen.findByRole("textbox", { name: /subdomain/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /create & continue/i })).toBeDefined();
  });

  it("holds step 2 back until an app is chosen", async () => {
    setToken("t");
    stubFetch([makeApp("cost-explorer", "Cost Explorer")]);
    render();

    expect(await screen.findByText(/pick or create an app first/i)).toBeDefined();
    expect(screen.queryByRole("tab", { name: /upload zip/i })).toBeNull();
    expect(screen.queryByText(/helix deploy/)).toBeNull();
  });

  it("unlocks step 2 against the picked app", async () => {
    setToken("t");
    stubFetch([makeApp("cost-explorer", "Cost Explorer")]);
    render();

    await userEvent.click(await screen.findByRole("combobox", { name: "App" }));
    await userEvent.click(await screen.findByText("Cost Explorer (cost-explorer)"));

    expect(await screen.findByText("helix deploy --slug cost-explorer")).toBeDefined();
    expect(screen.getByRole("tab", { name: /upload zip/i })).toBeDefined();
    expect(screen.queryByText(/pick or create an app first/i)).toBeNull();
  });

  it("creates an app inline and carries it into step 2", async () => {
    setToken("t");
    const created = stubFetch([makeApp("cost-explorer", "Cost Explorer")]);
    render();

    await userEvent.click(await screen.findByRole("radio", { name: "New app" }));
    await userEvent.type(await screen.findByRole("textbox", { name: /subdomain/i }), "standup");
    await userEvent.type(screen.getByRole("textbox", { name: /display name/i }), "Standup");
    await userEvent.click(screen.getByRole("button", { name: /create & continue/i }));

    expect(await screen.findByText("helix deploy --slug standup")).toBeDefined();
    expect(created).toEqual([
      { slug: "standup", displayName: "Standup", visibility: { mode: "internal" } },
    ]);
  });

  it("starts on the create form when the registry is empty", async () => {
    setToken("t");
    stubFetch([]);
    render();

    expect(await screen.findByRole("button", { name: /create & continue/i })).toBeDefined();
    const existing = await screen.findByRole("radio", { name: /existing app/i });
    expect(existing.hasAttribute("disabled")).toBe(true);
  });

  it("preselects the app it was opened from", async () => {
    setToken("t");
    stubFetch([makeApp("cost-explorer", "Cost Explorer")]);
    render("cost-explorer");

    expect(await screen.findByText("helix deploy --slug cost-explorer")).toBeDefined();
    // Step 1 shows the target, and its host, without the user touching anything.
    expect(await screen.findByText("Serves at cost-explorer.apps.example.com")).toBeDefined();
    expect(await screen.findByDisplayValue("Cost Explorer (cost-explorer)")).toBeDefined();
  });
});
