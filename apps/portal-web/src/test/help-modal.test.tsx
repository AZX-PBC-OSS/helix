import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./render";
import { AuthProvider } from "../auth/AuthProvider";
import { setToken, clearToken } from "../auth/tokenStore";
import { Shell } from "../components/Shell";
import { HelpModal } from "../modals/HelpModal";

/**
 * The onboarding modal is the one place the platform explains itself, and what
 * leaves it (the agent skill) is acted on directly by a coding agent — so the
 * assertions that matter are that it carries *this* deployment's hosts and that
 * it degrades honestly when the opt-in dev gateway isn't deployed.
 */

const AUTH_CONFIG = {
  issuer: "https://idp.test",
  cliClientId: "azx-cli",
  webClientId: "azx-portal-web",
};

function stubApi(config: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) =>
        Promise.resolve({ ok: true, status: 200, json: async () => body });
      if (url.endsWith("/api/v1/auth/config")) return json(AUTH_CONFIG);
      if (url.endsWith("/api/v1/config")) return json(config);
      if (url.endsWith("/api/v1/me")) return json({ sub: "alice@azx.dev", via: "oidc" });
      if (url.endsWith("/api/v1/apps")) return json([]);
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
        <Shell onDeploy={() => {}}>content</Shell>
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
    expect(screen.getByText(/npm link \.\/packages\/cli/)).toBeDefined();
  });

  it("downloads a skill rendered for this deployment, with no placeholders left", async () => {
    setToken("t");
    stubApi({
      appPublicBase: "https://apps.example.com",
      devApiBase: "https://dev-api.apps.example.com",
    });

    // Patch the two statics only — `useDeployment` parses hosts with `new URL()`,
    // so replacing the whole global would blank the config it depends on.
    let captured: Blob | null = null;
    URL.createObjectURL = (blob: Blob) => {
      captured = blob;
      return "blob:stub";
    };
    URL.revokeObjectURL = () => {};

    renderModal();
    // The buttons stay disabled until GET /api/v1/config lands; this is that signal.
    await screen.findByText("https://<slug>.apps.example.com");
    await userEvent.click(screen.getByRole("button", { name: /download SKILL\.md/i }));

    expect(captured).not.toBeNull();
    const text = await (captured as unknown as Blob).text();
    expect(text).not.toContain("{{");
    expect(text).toContain("https://<slug>.apps.example.com");
    expect(text).toContain("https://dev-api.apps.example.com/<slug>");
    // The models come from the shared pricing table, not a hardcoded list.
    expect(text).toContain("claude-haiku-4-5");
  });

  it("holds the skill back until the deployment config lands", async () => {
    setToken("t");
    // /api/v1/config never resolves: hostnames are unknown, so nothing may leave.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/auth/config")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => AUTH_CONFIG });
        }
        return new Promise(() => {});
      }),
    );
    renderModal();

    const download = await screen.findByRole("button", { name: /download SKILL\.md/i });
    expect(download.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: /copy agent instructions/i }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
