import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./render";
import { AuthProvider } from "../auth/AuthProvider";
import { setToken, clearToken } from "../auth/tokenStore";
import { DeployModal } from "../modals/DeployModal";

/**
 * The modal does one thing: ship a build into the app it was opened for. It has
 * no app picker and no create step — the picker was worse than the apps page at
 * picking, and registration lives on the apps page behind an always-visible button
 * (see `apps-list.test.tsx`, which holds the reachability line this file used to).
 *
 * Open state is asserted through `aria-expanded` on the controls, never through
 * whether the panel text is findable: Mantine's collapsed panels stay mounted
 * (hidden), so text presence says nothing about what the user can see.
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

const uploadControl = () => screen.getByRole("button", { name: /upload a build/i });
const cliControl = () => screen.getByRole("button", { name: /deploy from the command line/i });

/** Expand the CLI disclosure, which starts closed. */
async function openCli() {
  await userEvent.click(cliControl());
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
    expect(await screen.findByText(/Drop your build output folder/i)).toBeDefined();
    await openCli();
    expect(screen.getByText(/helix deploy --slug cost-explorer/)).toBeDefined();
  });

  it("points the copied command at this portal, not the CLI default", async () => {
    setToken("t");
    stubFetch();
    render("cost-explorer");

    // Without --portal-url the CLI resolves http://localhost:3001, so a command
    // copied off a deployed portal fails to connect and does not say why.
    await openCli();
    const cli = screen.getByText(/helix deploy --slug cost-explorer/);
    expect(cli.textContent).toContain(`--portal-url ${window.location.origin}`);
  });

  it("leads with the upload and puts the CLI under it", async () => {
    setToken("t");
    stubFetch();
    render("cost-explorer");

    // Not peers on a tab strip: the upload is the only path that works for
    // someone whose app was built in a browser.
    await screen.findByText(/Drop your build output folder/i);
    const upload = uploadControl();
    expect(
      upload.compareDocumentPosition(cliControl()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toEqual([]);
  });

  it("opens on the upload with the CLI collapsed", async () => {
    setToken("t");
    stubFetch();
    render("cost-explorer");

    await screen.findByText(/Drop your build output folder/i);
    expect(uploadControl().getAttribute("aria-expanded")).toBe("true");
    expect(cliControl().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the upload open when the CLI is expanded", async () => {
    setToken("t");
    stubFetch();
    render("cost-explorer");

    // A single-select accordion would collapse the dropzone out from under
    // anyone who opened the CLI row just to copy the command.
    await screen.findByText(/Drop your build output folder/i);
    await openCli();
    expect(cliControl().getAttribute("aria-expanded")).toBe("true");
    expect(uploadControl().getAttribute("aria-expanded")).toBe("true");
  });

  it("titles both sections and says who the CLI is for", async () => {
    setToken("t");
    stubFetch();
    render("cost-explorer");

    expect(await screen.findByText(/Upload a build/i)).toBeDefined();
    expect(screen.getByText(/Deploy from the command line/i)).toBeDefined();
    // A user asked us where their "app directory" was. The audience is named on
    // the closed row, so nobody has to open it to find out it isn't for them...
    expect(screen.getByText(/For developers using the helix CLI/i)).toBeDefined();
    // ...and again inside, where the folder gets the term that audience uses.
    await openCli();
    expect(screen.getByText(/command-line tool for developers/i)).toBeDefined();
    expect(screen.getByText(/project root/i)).toBeDefined();
  });

  it("offers no app picker or create step", async () => {
    setToken("t");
    stubFetch();
    render("cost-explorer");

    await screen.findByText(/Drop your build output folder/i);
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
