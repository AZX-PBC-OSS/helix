import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./render";
import { AuthProvider } from "../auth/AuthProvider";
import { setToken, clearToken } from "../auth/tokenStore";
import { Shell } from "../components/Shell";
import { HelpModal } from "../modals/HelpModal";
import { HelpProvider } from "../modals/HelpContext";
import { renderSkill } from "@azx-pbc/deploy-skill";
import skillTemplate from "@azx-pbc/deploy-skill/SKILL.md?raw";
import {
  BASELINE_BYTES_PER_DAY,
  BASELINE_DOLLARS_PER_DAY,
  BASELINE_FETCH_REQUESTS_PER_DAY,
  BASELINE_WRITES_PER_DAY,
} from "@azx-pbc/shared";

/**
 * The onboarding modal is the one place the platform explains itself, and what
 * leaves it (the agent skill) is acted on directly by a coding agent — so the
 * assertions that matter are that it carries *this* deployment's hosts and that
 * it degrades honestly when the opt-in dev gateway isn't deployed.
 *
 * Since ADR-0036 the skill is rendered server-side by `GET /api/v1/skill` and
 * fetched authed, not built client-side from `/api/v1/config` + `MODEL_PRICING`.
 * So the modal's hosts still come from `useDeployment()` (`/api/v1/config`), but
 * the skill body comes from the stubbed `/api/v1/skill` below — rendered here
 * with the real template + renderer so the "no placeholders" assertion stays
 * meaningful. The server's rendering (servable models, real caps) is covered by
 * the portal route test.
 */

const AUTH_CONFIG = {
  issuer: "https://idp.test",
  cliClientId: "azx-cli",
  webClientId: "azx-portal-web",
};

/** Render the skill as the portal would, for a given deployment shape. */
function renderSkillFor(opts: {
  appsHost: string;
  devApiBase: string | null;
  maxFileMb: number;
  maxBundleMb: number;
  models?: string[];
}): string {
  return renderSkill(skillTemplate, {
    portalOrigin: window.location.origin,
    appsHost: opts.appsHost,
    devApiBase: opts.devApiBase,
    llmModels: opts.models ?? ["claude-haiku-4-5"],
    maxFileMb: opts.maxFileMb,
    maxBundleMb: opts.maxBundleMb,
    baselineDollarsPerDay: BASELINE_DOLLARS_PER_DAY,
    baselineWritesPerDay: BASELINE_WRITES_PER_DAY,
    baselineBytesPerDay: BASELINE_BYTES_PER_DAY,
    baselineFetchRequestsPerDay: BASELINE_FETCH_REQUESTS_PER_DAY,
  });
}

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
function textRes(body: string) {
  return { ok: true, status: 200, json: async () => body, text: async () => body };
}

function stubApi(
  config: Record<string, unknown>,
  skill: string | Promise<never> = renderSkillFor({
    appsHost: "apps.example.com",
    devApiBase: null,
    maxFileMb: 50,
    maxBundleMb: 250,
  }),
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/auth/config")) return Promise.resolve(jsonRes(AUTH_CONFIG));
      if (url.endsWith("/api/v1/config")) return Promise.resolve(jsonRes(config));
      if (url.endsWith("/api/v1/me"))
        return Promise.resolve(jsonRes({ sub: "alice@azx.dev", via: "oidc" }));
      if (url.endsWith("/api/v1/apps")) return Promise.resolve(jsonRes([]));
      if (url.endsWith("/api/v1/skill")) {
        if (skill instanceof Promise) return skill;
        return Promise.resolve(textRes(skill));
      }
      return new Promise(() => {});
    }),
  );
}

function renderModal() {
  renderWithProviders(
    <AuthProvider>
      <HelpModal opened onClose={() => {}} />
    </AuthProvider>,
  );
}

const objectUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
  URL.createObjectURL = objectUrl.create;
  URL.revokeObjectURL = objectUrl.revoke;
});

describe("HelpModal", () => {
  it("opens from the sidebar", async () => {
    setToken("t");
    stubApi({ appPublicBase: "https://apps.example.com" });
    renderWithProviders(
      <AuthProvider>
        <HelpProvider>
          <Shell>content</Shell>
        </HelpProvider>
      </AuthProvider>,
    );

    expect(screen.queryByText("The four steps")).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: /how to develop/i }));
    expect(await screen.findByText("The four steps")).toBeDefined();
  });

  it("names this deployment's apps host and dev-gateway base", async () => {
    setToken("t");
    stubApi({
      appPublicBase: "https://apps.example.com",
      devApiBase: "https://dev-api.apps.example.com",
    });
    renderModal();

    expect(await screen.findByText("https://<slug>.apps.example.com")).toBeDefined();
    expect(
      await screen.findByText("https://dev-api.apps.example.com/<slug>/_api/llm/chat"),
    ).toBeDefined();
  });

  it("degrades to a hint when the deployment runs no dev gateway", async () => {
    setToken("t");
    stubApi({ appPublicBase: "https://apps.example.com" });
    renderModal();

    expect(await screen.findByText(/dev gateway isn't enabled on this deployment/i)).toBeDefined();
    // No invented host, and the CLI half is what's offered instead.
    expect(screen.queryByText(/dev-api\./)).toBeNull();
    expect(screen.getByText(/npm i -g @azx-pbc\/helix-cli/)).toBeDefined();
  });

  it("prints a helix.json pointing at this portal, before the commands that need it", async () => {
    setToken("t");
    stubApi({ appPublicBase: "https://apps.example.com" });
    renderModal();

    // The CLI cannot discover its portal: without portalUrl it resolves the
    // built-in http://localhost:3001, so every command in the block below fails
    // to connect on any deployed portal. Built from window.location.origin
    // rather than pinned, since that is exactly where the modal reads it from.
    const config = await screen.findByText(new RegExp(`"portalUrl": "${window.location.origin}"`));
    expect(config.textContent).toContain(`"slug": "my-app"`);

    // And it has to come first: `helix create` reads the slug out of the file.
    const commands = screen.getByText(/helix create --display-name/);
    expect(
      config.compareDocumentPosition(commands) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("downloads the skill the server rendered, with no placeholders left", async () => {
    setToken("t");
    // The skill body comes from /api/v1/skill; the caps/models below are what
    // the portal would have baked in for this deployment.
    stubApi(
      { appPublicBase: "https://apps.example.com", devApiBase: "https://dev-api.apps.example.com" },
      renderSkillFor({
        appsHost: "apps.example.com",
        devApiBase: "https://dev-api.apps.example.com",
        // Deliberately not the defaults (50/250): proves the caps in the offered
        // skill are this deployment's, not a constant in the bundle.
        maxFileMb: 80,
        maxBundleMb: 400,
      }),
    );

    let captured: Blob | null = null;
    URL.createObjectURL = (blob: Blob) => {
      captured = blob;
      return "blob:stub";
    };
    URL.revokeObjectURL = () => {};

    renderModal();
    // The buttons stay disabled until /api/v1/skill lands.
    const download = await screen.findByRole("button", { name: /download SKILL\.md/i });
    await waitFor(() => expect(download).toHaveProperty("disabled", false));
    await userEvent.click(download);

    expect(captured).not.toBeNull();
    const text = await (captured as unknown as Blob).text();
    expect(text).not.toContain("{{");
    expect(text).toContain("https://<slug>.apps.example.com");
    expect(text).toContain("https://dev-api.apps.example.com/<slug>");
    expect(text).toContain("claude-haiku-4-5");
    expect(text).toContain("80 MB per file");
    expect(text).toContain("400 MB per bundle");
  });

  it("holds the skill back until the skill endpoint resolves", async () => {
    setToken("t");
    // /api/v1/skill never resolves: the skill is unknown, so nothing may leave.
    stubApi({ appPublicBase: "https://apps.example.com" }, new Promise<never>(() => {}));
    renderModal();

    // The apps host (from /api/v1/config) lands, but the skill buttons stay
    // disabled because the authed /api/v1/skill fetch is still in flight.
    await screen.findByText("https://<slug>.apps.example.com");
    expect(
      screen.getByRole("button", { name: /download SKILL\.md/i }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: /copy agent instructions/i }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("holds the skill back when not signed in", async () => {
    // No token ⇒ not authenticated ⇒ the authed /api/v1/skill never fires, so
    // an unsigned visitor gets a disabled control rather than a skill fetch
    // that 401s in the background.
    stubApi({ appPublicBase: "https://apps.example.com" });
    renderModal();

    const download = await screen.findByRole("button", { name: /download SKILL\.md/i });
    expect(download.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: /copy agent instructions/i }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
