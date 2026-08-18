import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./render";
import { AuthProvider } from "../auth/AuthProvider";
import { setToken, clearToken } from "../auth/tokenStore";
import { DeployModal } from "../modals/DeployModal";

/**
 * The modal does one thing: ship a build into the app it was opened for. It has
 * no app picker and no create step — the picker was worse than My Apps at
 * picking, and registration lives on My Apps behind an always-visible button
 * (see `apps-list.test.tsx`, which holds the reachability line this file used to).
 */

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The deployment config; auth config and /me hang, as in the real first paint. */
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/config")
        return Promise.resolve(jsonResponse({ appPublicBase: "https://apps.example.com" }));
      return new Promise<Response>(() => {});
    }),
  );
}

function render(slug: string | null) {
  renderWithProviders(
    <AuthProvider>
      <DeployModal opened slug={slug} onClose={() => {}} />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("DeployModal", () => {
  it("targets the app it was opened for", async () => {
    setToken("t");
    stubFetch();
    render("cost-explorer");

    // Both halves of the flow address the app by slug, with nothing to choose.
    expect(await screen.findByText("helix deploy --slug cost-explorer")).toBeDefined();
    expect(screen.getByText(/Drop your build output folder/i)).toBeDefined();
  });

  it("leads with the upload and puts the CLI under it", async () => {
    setToken("t");
    stubFetch();
    render("cost-explorer");

    // Not peers on a tab strip: the upload is the only path that works for
    // someone whose app was built in a browser.
    const drop = await screen.findByText(/Drop your build output folder/i);
    const cli = screen.getByText("helix deploy --slug cost-explorer");
    expect(drop.compareDocumentPosition(cli) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toEqual([]);
  });

  it("titles both sections and says who the CLI is for", async () => {
    setToken("t");
    stubFetch();
    render("cost-explorer");

    expect(await screen.findByText(/Upload a build/i)).toBeDefined();
    expect(screen.getByText(/Or deploy from the command line/i)).toBeDefined();
    // A user asked us where their "app directory" was — the section leads with
    // the audience, then names the folder in the term that audience uses.
    expect(screen.getByText(/command-line tool for developers/i)).toBeDefined();
    expect(screen.getByText(/project root/i)).toBeDefined();
  });

  it("offers no app picker or create step", async () => {
    setToken("t");
    stubFetch();
    render("cost-explorer");

    await screen.findByText("helix deploy --slug cost-explorer");
    expect(screen.queryByRole("combobox", { name: "App" })).toBeNull();
    expect(screen.queryByRole("radio", { name: /existing app/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: /new app/i })).toBeNull();
    // The registration form is not embedded here any more.
    expect(screen.queryByRole("textbox", { name: /subdomain/i })).toBeNull();
  });

  it("renders nothing without a target", () => {
    setToken("t");
    stubFetch();
    render(null);

    expect(screen.queryByText(/helix deploy/)).toBeNull();
  });
});
