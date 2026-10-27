import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./render";
import { AuthProvider } from "../auth/AuthProvider";
import { setToken, clearToken } from "../auth/tokenStore";
import { PlatformSettingsPage } from "../pages/admin/PlatformSettingsPage";

function jsonResponse(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TERM = {
  id: "11111111-1111-4111-8111-111111111111",
  term: "acme",
  note: "client name",
  createdBy: "admin@example.com",
  createdAt: "2026-10-01T00:00:00.000Z",
};

function stubFetch() {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let terms = [TERM];
  let settings: Record<string, unknown> = {
    operatorName: "Example Co",
    operatorDescription: null,
    operatorContactUrl: null,
    updatedAt: null,
    updatedBy: null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url === "/api/v1/admin/settings" && method === "GET")
        return Promise.resolve(jsonResponse(settings));
      if (url === "/api/v1/admin/settings" && method === "PUT") {
        // Blank clears a field, as the real route does.
        const blank = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
        settings = {
          operatorName: blank(body.operatorName),
          operatorDescription: blank(body.operatorDescription),
          operatorContactUrl: blank(body.operatorContactUrl),
          updatedAt: new Date().toISOString(),
          updatedBy: "admin",
        };
        return Promise.resolve(jsonResponse(settings));
      }
      if (url === "/api/v1/admin/slug-terms" && method === "GET")
        return Promise.resolve(
          jsonResponse({
            terms,
            matchingApps: terms.length
              ? [{ slug: "acme-demo", displayName: "Demo", term: "acme" }]
              : [],
          }),
        );
      if (url === "/api/v1/admin/slug-terms" && method === "POST") {
        const added = {
          ...TERM,
          id: crypto.randomUUID(),
          term: body.term,
          note: body.note || null,
        };
        terms = [...terms, added];
        return Promise.resolve(jsonResponse(added, 201));
      }
      if (url.startsWith("/api/v1/admin/slug-terms/") && method === "DELETE") {
        terms = terms.filter((t) => !url.endsWith(t.id));
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "/api/v1/admin/config")
        return Promise.resolve(
          jsonResponse({
            entries: [
              {
                name: "APP_PUBLIC_BASE",
                description: "Where apps are served",
                secret: false,
                set: true,
                value: "https://apps.example.com",
              },
              {
                name: "PORTAL_SECRET",
                description: "Key that encrypts shared app passwords",
                secret: true,
                set: true,
                value: null,
              },
            ],
          }),
        );
      return new Promise<Response>(() => {});
    }),
  );
  return calls;
}

function render() {
  renderWithProviders(
    <AuthProvider>
      <PlatformSettingsPage />
    </AuthProvider>,
    { route: "/admin/settings" },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("PlatformSettingsPage", () => {
  it("edits the operator identity", async () => {
    setToken("t");
    const calls = stubFetch();
    render();

    const name = await screen.findByRole("textbox", { name: /organization name/i });
    await vi.waitFor(() => expect(name).toHaveProperty("value", "Example Co"));
    await userEvent.type(screen.getByRole("textbox", { name: /^about/i }), "We build things.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        operatorName: "Example Co",
        operatorDescription: "We build things.",
        operatorContactUrl: "",
      }),
    );
    // The save succeeded: the response parsed and the form shows who changed it.
    expect(await screen.findByText(/Last changed by admin/)).toBeDefined();
  });

  it("lists, adds and removes blocked terms, and flags existing apps", async () => {
    setToken("t");
    const calls = stubFetch();
    render();

    expect(await screen.findByText("client name")).toBeDefined();
    expect(screen.getByText("acme-demo (acme)")).toBeDefined();

    const term = screen.getByRole("textbox", { name: /^term/i });
    await userEvent.type(term, "Bad Term");
    expect(screen.getByRole("button", { name: "Block" })).toHaveProperty("disabled", true);
    await userEvent.clear(term);
    await userEvent.type(term, "Globex");
    await userEvent.click(screen.getByRole("button", { name: "Block" }));
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ term: "globex", note: "" }),
    );
    expect(await screen.findByText("globex")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "unblock acme" }));
    await vi.waitFor(() => expect(screen.queryByText("client name")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(TERM.id))).toBe(true);
  });

  it("shows config values but only the set/unset state of secrets", async () => {
    setToken("t");
    stubFetch();
    render();

    const row = (await screen.findByText("PORTAL_SECRET")).closest("tr")!;
    expect(within(row).getByText("set (secret)")).toBeDefined();
    expect(screen.getByText("https://apps.example.com")).toBeDefined();
  });
});
