import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  APPROVAL_BASELINES,
  CapabilitiesSchema,
  CURATED_LLM_MODELS,
  ELEVATION_TRIGGERS,
  type App,
  type AppManifest,
  type Capabilities,
  type CapabilityCatalogue,
  type CatalogueProvider,
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

function manifestBody(
  capabilities: Partial<Capabilities>,
  extra: Partial<AppManifest> = {},
): AppManifest {
  return {
    app: SLUG,
    visibility: { mode: "internal" },
    capabilities: { mcp: [], externalOrigins: [], ...capabilities },
    ...extra,
  };
}

/** One catalogue provider row (env-pinned; a ref may appear once per tier). */
function provider(
  overrides: Partial<CatalogueProvider> & Pick<CatalogueProvider, "ref">,
): CatalogueProvider {
  return {
    kind: "rest-delegated",
    displayName: "Asana",
    apiOrigins: ["https://app.asana.com"],
    env: "prod",
    ...overrides,
  };
}

function catalogueBody(providers: CatalogueProvider[]): CapabilityCatalogue {
  return {
    visibility: { modes: ["internal"] },
    llm: {
      models: [...CURATED_LLM_MODELS],
      baselineDollarsPerDay: APPROVAL_BASELINES.dollarsPerDay,
    },
    data: {
      provisioned: true,
      baselineWritesPerDay: APPROVAL_BASELINES.writesPerDay,
      baselineBytesPerDay: APPROVAL_BASELINES.bytesPerDay,
    },
    fetch: {
      externalOriginsPermitted: true,
      connections: [],
      providers,
      baselineRequestsPerDay: APPROVAL_BASELINES.fetchRequestsPerDay,
    },
    mcp: { enforced: false },
    offline: {
      available: true,
      scopeRule: "must not be the domain root or a /_… reserved path",
    },
    deploy: { maxFileMb: 50, maxBundleMb: 250 },
    approval: { baselines: APPROVAL_BASELINES, elevationTriggers: [...ELEVATION_TRIGGERS] },
  };
}

interface ApiStub {
  /** Every COMPLETED request — pended ones (auth config, /me) are not in it. */
  calls: { url: string; method: string }[];
  putBodies: unknown[];
}

/**
 * Serve the manifest GET (+ PUT for saves), an empty secrets list for the
 * SecretsCard, and the capability catalogue; auth config + /me pend forever,
 * irrelevant here. Several assertions below read the REQUEST LOG (the
 * reapproval badge consumes the manifest read alone; no preflight
 * connection-status discovery anywhere), so the stub records every call it
 * actually answers.
 */
function stubApi(
  opts: {
    manifest?: AppManifest;
    providers?: CatalogueProvider[];
    pending?: string | null;
  } = {},
): ApiStub {
  const stub: ApiStub = { calls: [], putBodies: [] };
  const served = opts.manifest ?? manifestBody({});
  const catalogue = catalogueBody(opts.providers ?? []);
  const record = (url: string, method: string) => stub.calls.push({ url, method });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      if (typeof url === "string" && url.endsWith("/manifest") && method === "PUT") {
        record(url, method);
        if (init?.body) stub.putBodies.push(JSON.parse(init.body));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ manifest: served, applied: [], pending: opts.pending ?? null }),
        });
      }
      if (typeof url === "string" && url.endsWith("/manifest")) {
        record(url, method);
        return Promise.resolve({ ok: true, status: 200, json: async () => served });
      }
      if (typeof url === "string" && url.endsWith("/secrets")) {
        record(url, method);
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      }
      if (typeof url === "string" && url.endsWith("/api/v1/capabilities")) {
        record(url, method);
        return Promise.resolve({ ok: true, status: 200, json: async () => catalogue });
      }
      return new Promise(() => {});
    }),
  );
  return stub;
}

function render() {
  // The catalogue query is bearer-gated (`enabled: authenticated`), so every
  // scenario here is a signed-in owner's.
  setToken("test-token");
  return renderWithProviders(
    <AuthProvider>
      <CapabilitiesTab app={makeApp()} />
    </AuthProvider>,
  );
}

/**
 * Open a Mantine Select and choose one of its options. The choice is scoped to
 * the opened combobox's own listbox (via aria-controls) — jsdom renders every
 * select's dropdown mounted-but-hidden, so unscoped text queries match too
 * much (the same reason `getByText`, not `getByRole("option")`, is the
 * repository's established option query).
 */
async function pickOption(combobox: RegExp | string, option: RegExp | string): Promise<void> {
  const combo = await screen.findByRole("combobox", { name: combobox });
  await userEvent.click(combo);
  const listbox = document.getElementById(combo.getAttribute("aria-controls") ?? "");
  expect(listbox).not.toBeNull();
  await userEvent.click(within(listbox as HTMLElement).getByText(option));
}

async function addOrigin(origin: string): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: "Add proxied origin" }));
  await userEvent.type(await screen.findByPlaceholderText("https://api.example.com"), origin);
}

/** The read-only manifest.yaml projection (one text node starting `app: demo`). */
const projection = () => screen.getByText(/app: demo/);

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("CapabilitiesTab — the credential select (spec decision 28)", () => {
  it("swaps in the provider picker + Required switch, removes the secret input, and saves the provider-bound origin through the approval flow", async () => {
    const stub = stubApi({ providers: [provider({ ref: "asana" })], pending: "req-1" });
    render();
    await addOrigin("https://app.asana.com");

    // Default credential is None — the row holds only the origin input; the
    // sibling control appears only when a credential mode is picked.
    expect(screen.getByRole("combobox", { name: "Credential" })).toHaveProperty("value", "None");
    expect(screen.queryByPlaceholderText("connection name")).toBeNull();

    // Stored secret mode: the sibling is today's connection-name input.
    await pickOption("Credential", "Stored secret");
    await userEvent.type(await screen.findByPlaceholderText("connection name"), "asana-prod");

    await pickOption("Credential", "OAuth provider");

    // The swap: secret input gone, picker in — one origin can never express
    // both credential sources.
    expect(screen.queryByPlaceholderText("connection name")).toBeNull();
    const picker = await screen.findByRole("combobox", { name: "OAuth provider" });
    // The Required switch waits until a provider is chosen.
    expect(screen.queryByRole("switch", { name: /Required/ })).toBeNull();

    // The picker's options come from the catalogue at RUNTIME (no build-time
    // provider config), one option per reference — "asana — Asana · prod"
    // (one tier configured here).
    await userEvent.click(picker);
    const listbox = document.getElementById(
      picker.getAttribute("aria-controls") ?? "",
    ) as HTMLElement;
    await userEvent.click(within(listbox).getByText("asana — Asana · prod"));

    // The dependency hint goes on.
    const required = await screen.findByRole("switch", { name: /Required/ });
    await userEvent.click(required);

    // The manifest draft shows the provider-bound origin…
    await waitFor(() =>
      expect(projection().textContent).toContain(
        "- origin: https://app.asana.com  (provider: asana, required)",
      ),
    );
    // …and the violet badge matches the secret-bound one.
    expect(screen.getByText("provider-bound origins need admin approval")).toBeDefined();

    // Saving opens the high-risk approval flow: the PUT carries the binding,
    // and the response's pending request raises the banner.
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    await waitFor(() => expect(screen.getByText(/awaiting admin approval/)).toBeDefined());
    expect(stub.putBodies).toHaveLength(1);
    const put = stub.putBodies[0] as { capabilities: Capabilities };
    expect(put.capabilities.fetch?.origins).toEqual([
      { origin: "https://app.asana.com", provider: "asana", required: true },
    ]);
  });

  it("shows the field error and blocks save when the origin is not one of the provider's API destinations, mirroring the server", async () => {
    stubApi({ providers: [provider({ ref: "asana" })] });
    render();
    await addOrigin("https://evil.example");
    await pickOption("Credential", "OAuth provider");
    await pickOption("OAuth provider", "asana — Asana · prod");

    // The server refuses a destination-less binding (criterion 15); the editor
    // mirrors it as a field error on the origin, and save is blocked.
    expect(
      await screen.findByText(/not one of provider "asana"'s permitted API destinations/),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: /Fix the origin binding to save/ })).toHaveProperty(
      "disabled",
      true,
    );

    // Naming a destination the provider actually serves clears the error.
    const origin = screen.getByPlaceholderText("https://api.example.com");
    await userEvent.clear(origin);
    await userEvent.type(origin, "https://app.asana.com");
    await waitFor(() =>
      expect(
        screen.queryByText(/not one of provider "asana"'s permitted API destinations/),
      ).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Save manifest" })).toHaveProperty("disabled", false);
  });

  it("mirrors the server across environments: the origin must be a destination of EVERY tier the ref is configured in", async () => {
    stubApi({
      providers: [
        provider({
          ref: "asana",
          env: "dev",
          apiOrigins: ["https://app.asana.com", "https://dev.asana.com"],
        }),
        provider({ ref: "asana", env: "prod" }),
      ],
    });
    render();
    await addOrigin("https://dev.asana.com");
    await pickOption("Credential", "OAuth provider");
    await pickOption(
      "OAuth provider",
      // Both tiers under one ref → the grouped label reads "dev+prod".
      "asana — Asana · dev+prod",
    );
    // The dev tier serves it; the prod row does not — the binding is refused.
    expect(
      await screen.findByText(/not one of provider "asana"'s permitted API destinations/),
    ).toBeDefined();
  });

  it("renders the OAuth provider option disabled with ask-an-administrator guidance when no providers are configured", async () => {
    stubApi({ providers: [] });
    render();
    await addOrigin("https://app.asana.com");

    const combo = screen.getByRole("combobox", { name: "Credential" });
    await userEvent.click(combo);
    const listbox = document.getElementById(combo.getAttribute("aria-controls") ?? "");
    const option = within(listbox as HTMLElement).getByText(
      /none configured on this deployment, ask an administrator/,
    );
    expect(option.closest('[role="option"]')).toHaveProperty("dataset.comboboxDisabled", "true");

    // Choosing it does nothing — the credential stays None.
    await userEvent.click(option);
    expect((combo as HTMLInputElement).value).toBe("None");
    expect(screen.queryByRole("combobox", { name: "OAuth provider" })).toBeNull();
  });

  it("hides the Required switch until a provider is chosen and saves it as the manifest field it is", async () => {
    const stub = stubApi({ providers: [provider({ ref: "asana" })] });
    render();
    await addOrigin("https://app.asana.com");
    await pickOption("Credential", "OAuth provider");
    expect(screen.queryByRole("switch", { name: /Required/ })).toBeNull();
    await pickOption("OAuth provider", "asana — Asana · prod");
    // Optional by default — the field is omitted, not false.
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    await waitFor(() => expect(stub.putBodies).toHaveLength(1));
    expect(
      (stub.putBodies[0] as { capabilities: Capabilities }).capabilities.fetch?.origins,
    ).toEqual([{ origin: "https://app.asana.com", provider: "asana" }]);
  });
});

describe("CapabilitiesTab — the Reapproval-needed badge (criterion 8)", () => {
  it("shows the badge from the manifest read alone, with no second request and no connection-status discovery", async () => {
    const stub = stubApi({
      manifest: manifestBody(
        {
          fetch: { shim: false, origins: [{ origin: "https://app.asana.com", provider: "asana" }] },
        },
        {
          providerBindings: [{ origin: "https://app.asana.com", ref: "asana", effective: false }],
        },
      ),
      providers: [provider({ ref: "asana" })],
    });
    render();
    expect(await screen.findByText(/Reapproval needed/)).toBeDefined();

    // The ENTIRE answered request log: the manifest read, the SecretsCard's
    // secrets list, the catalogue. The badge rides the manifest read — no
    // second request — and nothing asked the platform whether the user is
    // connected (clarifications §Out of Scope: `connection_required` at call
    // time is the only signal).
    expect(stub.calls.map((c) => c.url).sort()).toEqual(
      [
        `/api/v1/apps/${SLUG}/manifest`,
        "/api/v1/capabilities",
        `/api/v1/apps/${SLUG}/secrets`,
      ].sort(),
    );
  });

  it("does not show the badge while the stored binding is still effective", async () => {
    stubApi({
      manifest: manifestBody(
        {
          fetch: { shim: false, origins: [{ origin: "https://app.asana.com", provider: "asana" }] },
        },
        {
          providerBindings: [{ origin: "https://app.asana.com", ref: "asana", effective: true }],
        },
      ),
      providers: [provider({ ref: "asana" })],
    });
    render();
    await screen.findByPlaceholderText("https://api.example.com");
    await waitFor(() => expect(screen.queryByText(/Reapproval needed/)).toBeNull());
  });
});

describe("CapabilitiesTab — injected helpers (design decisions 5/7)", () => {
  it("renders two independent switches and persists both; connect-only is representable", async () => {
    const stub = stubApi({ manifest: manifestBody({}) });
    render();

    const fetchSwitch = await screen.findByRole("switch", { name: /Rewrite fetch\/XHR/ });
    const connect = screen.getByRole("switch", { name: /Connect helper/ });
    expect(fetchSwitch).toHaveProperty("checked", false);
    expect(connect).toHaveProperty("checked", false);

    // The connect helper toggles WITHOUT the fetch rewrite — independent
    // sub-options, either grantable alone.
    await userEvent.click(connect);
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    await waitFor(() => expect(stub.putBodies).toHaveLength(1));
    expect((stub.putBodies[0] as { capabilities: Capabilities }).capabilities.shim).toEqual({
      fetch: false,
      connect: true,
    });

    // The keyboard path: focus the switch, toggle with space.
    fetchSwitch.focus();
    await userEvent.keyboard(" ");
    expect(fetchSwitch).toHaveProperty("checked", true);
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    await waitFor(() => expect(stub.putBodies).toHaveLength(2));
    expect((stub.putBodies[1] as { capabilities: Capabilities }).capabilities.shim).toEqual({
      fetch: true,
      connect: true,
    });
  });

  it("shows a connect-only grant as the equivalent state without implying the fetch rewrite", async () => {
    stubApi({ manifest: manifestBody({ shim: { fetch: false, connect: true } }) });
    render();
    expect(await screen.findByRole("switch", { name: /Rewrite fetch\/XHR/ })).toHaveProperty(
      "checked",
      false,
    );
    expect(screen.getByRole("switch", { name: /Connect helper/ })).toHaveProperty("checked", true);
  });
});

describe("CapabilitiesTab — keyboard/screen-reader operation", () => {
  it("drives the credential select, the provider picker, and the Required switch without a pointer", async () => {
    stubApi({ providers: [provider({ ref: "asana" })] });
    render();
    await addOrigin("https://app.asana.com");

    // The credential select: focus, ArrowDown opens the dropdown and activates
    // the first option, navigate, Enter picks — standard Mantine combobox
    // semantics, no tabindex games.
    const combo = screen.getByRole("combobox", { name: "Credential" });
    combo.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => expect(combo).toHaveProperty("value", "OAuth provider"));

    // The provider picker, the same way.
    const picker = await screen.findByRole("combobox", { name: "OAuth provider" });
    picker.focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(picker).toHaveProperty("value", "asana — Asana · prod"));

    // The Required switch: focus + space.
    const required = await screen.findByRole("switch", { name: /Required/ });
    required.focus();
    await userEvent.keyboard(" ");
    await waitFor(() =>
      expect(projection().textContent).toContain(
        "- origin: https://app.asana.com  (provider: asana, required)",
      ),
    );
  });
});

describe("CapabilitiesTab — legacy shim compatibility (criterion 14, design decision 6)", () => {
  it("a legacy boolean-shim app displays the equivalent new-form state, and resaving writes the new form without losing the grant", async () => {
    const stub = stubApi({
      // The STORED legacy spelling — the raw boolean, no shim block.
      manifest: manifestBody({
        fetch: { shim: true, origins: [{ origin: "https://api.github.com" }] },
      }),
    });
    render();

    // The equivalent new-form display: the rewrite is on, the connect helper is not.
    expect(await screen.findByRole("switch", { name: /Rewrite fetch\/XHR/ })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByRole("switch", { name: /Connect helper/ })).toHaveProperty("checked", false);
    // The projection writes only the new form, for a legacy app too.
    expect(projection().textContent).toContain("shim:");
    expect(projection().textContent).toContain("fetch: true");
    expect(projection().textContent).toContain("connect: false");
    expect(projection().textContent).toContain("- origin: https://api.github.com");

    // Resave (made dirty by turning the connect helper on): the PUT body keeps
    // the grant, and parses to exactly the same capability set — nothing
    // behavioral changed.
    await userEvent.click(screen.getByRole("switch", { name: /Connect helper/ }));
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    await waitFor(() => expect(stub.putBodies).toHaveLength(1));
    const saved = (stub.putBodies[0] as { capabilities: Capabilities }).capabilities;
    const parsed = CapabilitiesSchema.parse(saved);
    expect(parsed.fetch?.shim).toBe(true);
    expect(parsed.fetch?.origins).toEqual([{ origin: "https://api.github.com" }]);
    expect(parsed.shim).toEqual({ fetch: true, connect: true });
  });
});

describe("CapabilitiesTab — the manifest.yaml projection", () => {
  it("renders the shim block and provider-bound origins for a new-form app", async () => {
    stubApi({
      manifest: manifestBody({
        fetch: {
          shim: false,
          origins: [{ origin: "https://app.asana.com", provider: "asana", required: true }],
        },
        shim: { fetch: true, connect: false },
      }),
      providers: [provider({ ref: "asana" })],
    });
    render();
    await screen.findByRole("switch", { name: /Rewrite fetch\/XHR/ });
    const text = projection().textContent ?? "";
    expect(text).toContain("shim:");
    expect(text).toContain("fetch: true");
    expect(text).toContain("connect: false");
    expect(text).toContain("- origin: https://app.asana.com  (provider: asana, required)");
  });

  it("renders the shim block for a connect-only app with both sub-options' stored values", async () => {
    stubApi({ manifest: manifestBody({ shim: { fetch: false, connect: true } }) });
    render();
    await screen.findByRole("switch", { name: /Connect helper/ });
    const text = projection().textContent ?? "";
    expect(text).toContain("shim:");
    expect(text).toContain("fetch: false");
    expect(text).toContain("connect: true");
  });
});
