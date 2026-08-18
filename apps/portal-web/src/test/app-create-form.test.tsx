import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { App } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { AuthProvider } from "../auth/AuthProvider";
import { setToken, clearToken } from "../auth/tokenStore";
import { AppCreateForm } from "../components/AppCreateForm";

/**
 * The gate on visibility at create time. `group` is listed but unselectable
 * because the edge's directory-group check isn't implemented — offering it
 * would register apps against a gate that never runs. These tests are the pin
 * that stops it being re-enabled ahead of the check.
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
    url: `https://${slug}.apps.example.com`,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * POST /apps (the create) + the deployment config + an auth config that permits
 * every open surface, so the disabled state under test is the form's own and not
 * an artefact of deployment policy.
 */
function stubFetch() {
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
      if (url === "/api/v1/config")
        return Promise.resolve(jsonResponse({ appPublicBase: APPS_BASE }));
      if (url === "/api/v1/auth/config")
        return Promise.resolve(
          jsonResponse({
            issuer: "https://idp.example",
            cliClientId: "azx-cli",
            allowPublicApps: true,
            allowPasswordApps: true,
          }),
        );
      return new Promise<Response>(() => {}); // /me: pending
    }),
  );
  return created;
}

function render(onCreated: (app: App) => void = () => {}) {
  renderWithProviders(
    <AuthProvider>
      <AppCreateForm onCreated={onCreated} />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("AppCreateForm", () => {
  it("states the visibility instead of asking, while there is one answer", async () => {
    setToken("t");
    stubFetch();
    render();

    // A control with one selectable row reads as a choice it isn't, so the form
    // says what the app will be and where to change it — no radios at all.
    expect(await screen.findByText(/Internal/)).toBeDefined();
    expect(await screen.findByText(/change this any time on the app's Access tab/)).toBeDefined();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryAllByRole("radio")).toEqual([]);
  });

  it("creates internal apps", async () => {
    setToken("t");
    const created = stubFetch();
    render();

    await userEvent.type(await screen.findByRole("textbox", { name: /subdomain/i }), "standup");
    await userEvent.type(screen.getByRole("textbox", { name: /display name/i }), "Standup");
    await userEvent.click(screen.getByRole("button", { name: /create app/i }));

    await vi.waitFor(() =>
      expect(created).toEqual([
        { slug: "standup", displayName: "Standup", visibility: { mode: "internal" } },
      ]),
    );
  });

  it("asks for nothing beyond the subdomain and display name", async () => {
    setToken("t");
    stubFetch();
    render();

    await screen.findByRole("textbox", { name: /subdomain/i });
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    // Group is the mode most likely to creep back in ahead of its gate.
    expect(screen.queryByRole("textbox", { name: /group id/i })).toBeNull();
  });
});
