import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BASELINE_DOLLARS_PER_DAY,
  CURATED_LLM_MODELS,
  type App,
  type AppManifest,
  type Capabilities,
} from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { CapabilitiesTab } from "../pages/tabs/CapabilitiesTab";
import { AuthProvider } from "../auth/AuthProvider";
import { clearToken, setToken } from "../auth/tokenStore";

const SLUG = "demo";

function makeApp(): App {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: SLUG,
    displayName: "Demo",
    visibility: { mode: "internal" },
    currentVersionId: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function manifest(capabilities: Partial<Capabilities>): AppManifest {
  return {
    app: SLUG,
    visibility: { mode: "internal" },
    capabilities: { mcp: [], externalOrigins: [], ...capabilities },
  };
}

/**
 * Serve the manifest GET (and an empty secrets list for the SecretsCard); auth
 * config + /me pend forever, irrelevant here. `retry: false` keeps it quiet.
 */
function stubFetch(m: AppManifest): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (typeof url === "string" && url.endsWith("/manifest")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => m });
      }
      if (typeof url === "string" && url.endsWith("/secrets")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      }
      return new Promise(() => {});
    }),
  );
}

function render() {
  return renderWithProviders(
    <AuthProvider>
      <CapabilitiesTab app={makeApp()} />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("CapabilitiesTab — LLM access", () => {
  it("renders the priced catalogue as checkbox rows", async () => {
    stubFetch(manifest({}));
    render();
    // Every curated model shows up with a toggle.
    for (const id of CURATED_LLM_MODELS) {
      expect(await screen.findByRole("checkbox", { name: id })).toBeDefined();
    }
    // ...and at least one catalogue rate is visible.
    expect(screen.getAllByText("$1").length).toBeGreaterThan(0); // haiku input rate
  });

  it("defaults the spend cap to $10 when the first model is enabled", async () => {
    stubFetch(manifest({}));
    setToken("test-token");
    render();
    const user = userEvent.setup();

    // The cap input is present but disabled until a model is enabled.
    const cap = (await screen.findByPlaceholderText("10")) as HTMLInputElement;
    expect(cap.disabled).toBe(true);

    await user.click(await screen.findByRole("checkbox", { name: "claude-opus-4-8" }));
    await waitFor(() => expect(cap.value).toMatch(/10/));
    expect(cap.disabled).toBe(false);
  });

  it("requires a cap: a legacy uncapped app warns and blocks save", async () => {
    stubFetch(manifest({ llm: { models: ["claude-opus-4-8"] } }));
    setToken("test-token");
    render();

    expect(await screen.findByText(/A daily spend cap is required/)).toBeDefined();
    expect(screen.getByRole("button", { name: /Set a spend cap to save/ })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("shows the approval warning only above the baseline", async () => {
    // At the baseline: cap reflected in the header input, no approval warning.
    stubFetch(
      manifest({ llm: { models: ["claude-opus-4-8"], dollarsPerDay: BASELINE_DOLLARS_PER_DAY } }),
    );
    const atBaseline = render();
    expect(((await atBaseline.findByPlaceholderText("10")) as HTMLInputElement).value).toMatch(
      new RegExp(String(BASELINE_DOLLARS_PER_DAY)),
    );
    expect(atBaseline.queryByText(/saving opens an admin-approval request/)).toBeNull();
    atBaseline.unmount();
    vi.unstubAllGlobals();

    // One dollar over: the warning appears, referencing the shared constant.
    stubFetch(
      manifest({
        llm: { models: ["claude-opus-4-8"], dollarsPerDay: BASELINE_DOLLARS_PER_DAY + 1 },
      }),
    );
    render();
    expect(
      await screen.findByText(new RegExp(`above the \\$${BASELINE_DOLLARS_PER_DAY}/day baseline`)),
    ).toBeDefined();
    expect(screen.getByText(/saving opens an admin-approval request/)).toBeDefined();
  });

  it("flags an off-catalogue custom model as needing approval", async () => {
    stubFetch(manifest({ llm: { models: ["my-private-model"], dollarsPerDay: 10 } }));
    render();
    expect(await screen.findByRole("checkbox", { name: "my-private-model" })).toBeDefined();
    expect(await screen.findByText(/custom — unpriced/)).toBeDefined();
    expect(screen.getByText(/needs admin approval/)).toBeDefined();
  });
});

describe("CapabilitiesTab — a save that conflicts", () => {
  /**
   * Serve the manifest, then answer the PUT with a 409 and serve a *different*
   * manifest afterwards — the shape of a lost race, where the stored value has
   * moved by definition.
   */
  function stubConflictingSave(before: AppManifest, after: AppManifest) {
    let saved = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: { method?: string }) => {
        if (typeof url === "string" && url.endsWith("/manifest") && init?.method === "PUT") {
          saved = true;
          return Promise.resolve({
            ok: false,
            status: 409,
            json: async () => ({
              error: {
                code: "conflict",
                message:
                  "this app's policy changed while you were editing it — reload and try again",
              },
            }),
          });
        }
        if (typeof url === "string" && url.endsWith("/manifest")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => (saved ? after : before),
          });
        }
        if (typeof url === "string" && url.endsWith("/secrets")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => [] });
        }
        return new Promise(() => {});
      }),
    );
  }

  it("keeps the owner's edits on the screen instead of resetting them", async () => {
    // The draft is reseeded whenever the fetched capabilities change reference, so
    // a mutation that invalidates the manifest query on *error* would reset this
    // form to the other writer's value — wiping the edits at the exact moment the
    // message says "try again", with nowhere left to try them from.
    stubConflictingSave(
      manifest({ llm: { models: [], dollarsPerDay: 10 } }),
      manifest({ llm: { models: ["claude-haiku-4-5"], dollarsPerDay: 10 } }),
    );
    setToken("test-token");
    render();

    const model = "claude-opus-4-8";
    await userEvent.click(await screen.findByRole("checkbox", { name: model }));
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));

    await waitFor(() => {
      expect(screen.getByText(/policy changed while you were editing it/)).toBeDefined();
    });
    // Still checked, and still savable — the edit survived the conflict.
    expect((screen.getByRole("checkbox", { name: model }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: /Save manifest/ })).toHaveProperty("disabled", false);
  });
});
