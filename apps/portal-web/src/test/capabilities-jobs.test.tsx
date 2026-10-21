import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  APPROVAL_BASELINES,
  CURATED_LLM_MODELS,
  ELEVATION_TRIGGERS,
  type App,
  type AppManifest,
  type Capabilities,
  type CapabilityCatalogue,
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
 * A catalogue body valid against `CapabilityCatalogueSchema`, with the
 * advertised job types — the field under test — as the knob. `undefined`
 * omits the block entirely (jobs fully disabled on this deployment).
 */
function catalogueBody(jobTypes?: CapabilityCatalogue["jobs"]): CapabilityCatalogue {
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
      providers: [],
      baselineRequestsPerDay: APPROVAL_BASELINES.fetchRequestsPerDay,
    },
    mcp: { enforced: false },
    offline: {
      available: true,
      scopeRule: "must not be the domain root or a /_… reserved path",
    },
    ...(jobTypes ? { jobs: jobTypes } : {}),
    deploy: { maxFileMb: 50, maxBundleMb: 250 },
    approval: { baselines: APPROVAL_BASELINES, elevationTriggers: [...ELEVATION_TRIGGERS] },
  };
}

const FETCH_ENTRY = { id: "jobs:fetch", displayName: "Outbound fetch job" } as const;
/**
 * A second installed type — syntactically valid on the wire, and deliberately
 * absent from the editor's per-type description map: the catalogue entry is
 * pinned to `{id, displayName}`, so a future deployment's type has no
 * description the editor could know.
 */
const REPORT_ENTRY = { id: "jobs:report", displayName: "Report generator" } as const;

/** The PUT's captured body, for asserting what the editor saved. */
let lastPut: unknown;

/**
 * Serve the manifest GET, an empty secrets list, and the capability catalogue.
 * `catalogue: "fail"` answers 500 — the discovery-failure shape. A `setCatalogue`
 * escape hatch lets a test flip the catalogue between render and Retry.
 */
function stubFetch(
  m: AppManifest,
  opts: { catalogue?: CapabilityCatalogue | "fail" } = {},
): { setCatalogue: (c: CapabilityCatalogue | "fail") => void } {
  let current = opts.catalogue ?? catalogueBody({ types: [FETCH_ENTRY] });
  lastPut = undefined;
  const setCatalogue = (c: CapabilityCatalogue | "fail") => {
    current = c;
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { method?: string; body?: string }) => {
      if (typeof url === "string" && url.endsWith("/manifest") && init?.method === "PUT") {
        lastPut = JSON.parse(init.body ?? "{}");
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ manifest: m, applied: [], pending: null }),
        });
      }
      if (typeof url === "string" && url.endsWith("/manifest")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => m });
      }
      if (typeof url === "string" && url.endsWith("/secrets")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      }
      if (typeof url === "string" && url.endsWith("/api/v1/capabilities")) {
        if (current === "fail") {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({ error: { code: "internal", message: "discovery down" } }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => current });
      }
      return new Promise(() => {});
    }),
  );
  return { setCatalogue };
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

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("CapabilitiesTab — background jobs", () => {
  it("renders the advertised types as labelled checkboxes with their qualified code", async () => {
    stubFetch(manifest({}));
    render();
    const box = (await screen.findByRole("checkbox", {
      name: /Outbound fetch job/,
    })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    // The full qualified name sits beside the label, so future servers with
    // similarly named jobs stay distinguishable (design.md, Background jobs card).
    expect(screen.getByText("jobs:fetch")).toBeDefined();
  });

  it("saves a selected type through the ordinary manifest PUT", async () => {
    stubFetch(manifest({}));
    render();
    await userEvent.click(await screen.findByRole("checkbox", { name: /Outbound fetch job/ }));
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    await waitFor(() => {
      const capabilities = (lastPut as { capabilities?: Capabilities })?.capabilities;
      expect(capabilities?.jobs).toEqual({ types: ["jobs:fetch"] });
    });
  });

  it("an unrelated save preserves the saved grant", async () => {
    stubFetch(manifest({ jobs: { types: ["jobs:fetch"] } }));
    render();
    // The saved grant starts checked…
    const box = (await screen.findByRole("checkbox", {
      name: /Outbound fetch job/,
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    // …an LLM edit makes the save dirty without touching jobs…
    await userEvent.click(await screen.findByRole("checkbox", { name: "claude-opus-4-8" }));
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    // …and the PUT carries the jobs block unchanged.
    await waitFor(() => {
      const capabilities = (lastPut as { capabilities?: Capabilities })?.capabilities;
      expect(capabilities?.llm?.models).toContain("claude-opus-4-8");
      expect(capabilities?.jobs).toEqual({ types: ["jobs:fetch"] });
    });
  });

  it("unchecking the last type removes the grant, with the removal guidance before saving", async () => {
    stubFetch(manifest({ jobs: { types: ["jobs:fetch"] } }));
    render();
    const box = (await screen.findByRole("checkbox", {
      name: /Outbound fetch job/,
    })) as HTMLInputElement;
    await userEvent.click(box);
    // Design.md's removal copy, shown before the save — no second dialog.
    expect(await screen.findByText(/Saving removes access to these job types/)).toBeDefined();
    expect(screen.getByText(/Already accepted jobs continue/)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    await waitFor(() => {
      const capabilities = (lastPut as { capabilities?: Capabilities })?.capabilities;
      expect(capabilities?.jobs).toBeUndefined();
    });
  });

  it("does not show the removal guidance while nothing saved is being removed", async () => {
    stubFetch(manifest({}));
    render();
    await screen.findByRole("checkbox", { name: /Outbound fetch job/ });
    expect(screen.queryByText(/Saving removes access to these job types/)).toBeNull();
  });

  it("the removal guidance clears when the removal is undone before saving", async () => {
    // The warning reads the live difference between saved and selected —
    // unchecking shows it, re-checking the same type must clear it again, so
    // an owner who reverses course is not left with a false "Saving removes
    // access" while keeping the grant.
    stubFetch(manifest({ jobs: { types: ["jobs:fetch"] } }));
    render();
    const box = (await screen.findByRole("checkbox", {
      name: /Outbound fetch job/,
    })) as HTMLInputElement;
    await userEvent.click(box); // uncheck — the removal warning appears
    expect(await screen.findByText(/Saving removes access to these job types/)).toBeDefined();
    await userEvent.click(box); // re-check — the removal is undone
    expect(screen.queryByText(/Saving removes access to these job types/)).toBeNull();
    expect(box.checked).toBe(true);
    // The draft round-trips back to the saved state: nothing jobs-shaped is
    // dirty, so the save button is back to its clean label.
    expect(screen.getByRole("button", { name: "Saved" })).toBeDefined();
  });

  it("a saved type the deployment no longer offers stays visible and removable", async () => {
    // Fully disabled jobs: no `jobs` block in the catalogue at all.
    stubFetch(manifest({ jobs: { types: ["jobs:fetch"] } }), { catalogue: catalogueBody() });
    render();
    const box = (await screen.findByRole("checkbox", {
      name: /jobs:fetch/,
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(await screen.findByText(/not offered on this deployment/)).toBeDefined();
    // Removable through the ordinary save: uncheck, save, the block is gone.
    await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    await waitFor(() => {
      const capabilities = (lastPut as { capabilities?: Capabilities })?.capabilities;
      expect(capabilities?.jobs).toBeUndefined();
    });
  });

  it("discovery failure offers Retry and keeps the selections", async () => {
    const { setCatalogue } = stubFetch(manifest({ jobs: { types: ["jobs:fetch"] } }), {
      catalogue: "fail",
    });
    render();
    // The saved selection stays checked while discovery is down — a failed
    // catalogue must not read as an empty grant.
    const box = (await screen.findByRole("checkbox", {
      name: /jobs:fetch/,
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await screen.findByText(/Couldn't load the job type catalogue/);
    const retry = screen.getByRole("button", { name: "Retry" });

    setCatalogue(catalogueBody({ types: [FETCH_ENTRY] }));
    await userEvent.click(retry);
    // Recovery renders the advertised row — same type, still checked.
    await waitFor(() => {
      expect(
        (screen.getByRole("checkbox", { name: /Outbound fetch job/ }) as HTMLInputElement).checked,
      ).toBe(true);
    });
    expect(screen.queryByText(/Couldn't load the job type catalogue/)).toBeNull();
  });

  it("removing a grant works while discovery is down", async () => {
    // Discovery failed on load: the saved row renders plainly (its availability
    // is unknown, not withdrawn), and removal — the direction that is always
    // available — still saves.
    stubFetch(manifest({ jobs: { types: ["jobs:fetch"] } }), { catalogue: "fail" });
    render();
    const box = (await screen.findByRole("checkbox", {
      name: /jobs:fetch/,
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.queryByText(/not offered on this deployment/)).toBeNull();
    await userEvent.click(box);
    expect(await screen.findByText(/Saving removes access to these job types/)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    await waitFor(() => {
      const capabilities = (lastPut as { capabilities?: Capabilities })?.capabilities;
      expect(capabilities?.jobs).toBeUndefined();
    });
  });

  it("a held type is not flagged while the catalogue has not answered", async () => {
    // The catalogue request never resolves: nothing is classified yet, so the
    // held row renders plainly — no false "not offered" flash, the model
    // picker's loading posture.
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (typeof url === "string" && url.endsWith("/manifest")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => manifest({ jobs: { types: ["jobs:fetch"] } }),
          });
        }
        if (typeof url === "string" && url.endsWith("/secrets")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => [] });
        }
        return new Promise(() => {}); // catalogue: pending forever
      }),
    );
    render();
    const box = (await screen.findByRole("checkbox", {
      name: /jobs:fetch/,
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.queryByText(/not offered on this deployment/)).toBeNull();
    expect(await screen.findByText(/Loading the job type catalogue/)).toBeDefined();
  });

  it("a held type is flagged only once the arrived catalogue confirms it", async () => {
    // The catalogue is pending on render and lands WITHOUT the held type: the
    // row renders plainly until the answer arrives, and the classification is
    // re-read from what arrived — the same row upgrades to flagged, and the
    // saved selection survives the transition.
    let arrive: (body: CapabilityCatalogue) => void = () => {};
    const cataloguePending = new Promise<CapabilityCatalogue>((resolve) => {
      arrive = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (typeof url === "string" && url.endsWith("/manifest")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => manifest({ jobs: { types: ["jobs:legacy"] } }),
          });
        }
        if (typeof url === "string" && url.endsWith("/secrets")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => [] });
        }
        if (typeof url === "string" && url.endsWith("/api/v1/capabilities")) {
          return cataloguePending.then((body) => ({
            ok: true,
            status: 200,
            json: async () => body,
          }));
        }
        return new Promise(() => {});
      }),
    );
    render();
    const box = (await screen.findByRole("checkbox", {
      name: /jobs:legacy/,
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.queryByText(/not offered on this deployment/)).toBeNull();
    expect(await screen.findByText(/Loading the job type catalogue/)).toBeDefined();

    arrive(catalogueBody()); // no jobs block — the deployment has withdrawn it
    expect(await screen.findByText(/not offered on this deployment/)).toBeDefined();
    expect(
      (screen.getByRole("checkbox", { name: /jobs:legacy/ }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("shows the empty-selection guidance", async () => {
    stubFetch(manifest({}), { catalogue: catalogueBody() });
    render();
    expect(await screen.findByText(/No job types selected/)).toBeDefined();
    expect(screen.getByText(/leaves no background jobs grant/)).toBeDefined();
  });

  it("renders the card's standing copy — title, description, capacity and identity guidance", async () => {
    // design.md's "Background jobs card" copy table, verbatim. The conditional
    // rows (removal, empty selection, fetch guidance, per-type description)
    // are pinned by their own tests; these four render whenever the card does
    // and nothing else asserts them.
    stubFetch(manifest({}), { catalogue: catalogueBody() });
    render();
    expect(await screen.findByText("Background jobs")).toBeDefined();
    expect(
      screen.getByText(
        "Run platform-provided work in the background. Jobs accept inputs, not app code.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Platform limits protect submission rate, queue capacity and stored results. " +
          "Busy requests may need to be retried later.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Jobs require an authenticated user or a development token. Anonymous visitors " +
          "and shared-password sessions cannot use them.",
      ),
    ).toBeDefined();
  });

  it("the manifest preview carries the jobs types", async () => {
    stubFetch(manifest({ jobs: { types: ["jobs:fetch"] } }));
    render();
    // The preview normalizes whitespace, so the block reads "jobs: types: […]".
    expect(await screen.findByText(/jobs:\s*types: \[jobs:fetch\]/)).toBeDefined();
  });

  it("renders every advertised type, describing only the types this editor knows", async () => {
    stubFetch(manifest({}), { catalogue: catalogueBody({ types: [FETCH_ENTRY, REPORT_ENTRY] }) });
    render();
    const fetchBox = await screen.findByRole("checkbox", { name: /Outbound fetch job/ });
    const reportBox = await screen.findByRole("checkbox", { name: /Report generator/ });
    expect(screen.getByText("jobs:report")).toBeDefined();
    // Guidance is programmatically associated where the editor has copy for the
    // type, and a type it has none for (the wire entry is only {id,
    // displayName}) still renders — label + code, no description, no crash.
    expect(fetchBox.getAttribute("aria-describedby")).not.toBeNull();
    expect(reportBox.getAttribute("aria-describedby")).toBeNull();
    expect(
      screen.getByText("Fetch one JSON response using this app's fetch permissions."),
    ).toBeDefined();
  });

  it("selecting a non-fetch type shows no fetch guidance, and both types save", async () => {
    stubFetch(manifest({}), { catalogue: catalogueBody({ types: [FETCH_ENTRY, REPORT_ENTRY] }) });
    render();
    await screen.findByRole("checkbox", { name: /Report generator/ });
    // Nothing held: no fetch guidance, the empty-selection line, and no jobs
    // block promised in the preview (an empty block is not a grant).
    expect(screen.queryByText(/Configure allowed origins in Fetch proxy/)).toBeNull();
    expect(screen.getByText(/No job types selected/)).toBeDefined();
    expect(screen.queryByText(/jobs:\s*types:/)).toBeNull();

    await userEvent.click(screen.getByRole("checkbox", { name: /Report generator/ }));
    expect(screen.queryByText(/No job types selected/)).toBeNull();
    // The fetch guidance is about the fetch type specifically — a different
    // selected type does not surface it.
    expect(screen.queryByText(/Configure allowed origins in Fetch proxy/)).toBeNull();

    await userEvent.click(screen.getByRole("checkbox", { name: /Outbound fetch job/ }));
    expect(await screen.findByText(/Configure allowed origins in Fetch proxy/)).toBeDefined();
    expect(await screen.findByText(/types: \[jobs:report, jobs:fetch\]/)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    await waitFor(() => {
      const capabilities = (lastPut as { capabilities?: Capabilities })?.capabilities;
      expect(capabilities?.jobs).toEqual({ types: ["jobs:report", "jobs:fetch"] });
    });
  });

  it("removing one of two saved types keeps the grant for the other", async () => {
    stubFetch(manifest({ jobs: { types: ["jobs:fetch", "jobs:report"] } }), {
      catalogue: catalogueBody({ types: [FETCH_ENTRY, REPORT_ENTRY] }),
    });
    render();
    const fetchBox = (await screen.findByRole("checkbox", {
      name: /Outbound fetch job/,
    })) as HTMLInputElement;
    const reportBox = (await screen.findByRole("checkbox", {
      name: /Report generator/,
    })) as HTMLInputElement;
    expect(fetchBox.checked).toBe(true);
    expect(reportBox.checked).toBe(true);
    expect(screen.queryByText(/Saving removes access to these job types/)).toBeNull();

    await userEvent.click(reportBox);
    // The removal guidance reads the difference, and the save removes only the
    // unchecked type — the grant survives for the one still selected.
    expect(await screen.findByText(/Saving removes access to these job types/)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    await waitFor(() => {
      const capabilities = (lastPut as { capabilities?: Capabilities })?.capabilities;
      expect(capabilities?.jobs).toEqual({ types: ["jobs:fetch"] });
    });
  });

  it("a withdrawn saved type survives an unrelated save when jobs is fully disabled", async () => {
    // The catalogue advertises nothing (no jobs block): the saved type cannot be
    // re-offered, so a save that silently dropped it would destroy the one grant
    // the editor cannot re-create. design.md: unrelated manifest saves must not
    // silently discard the jobs grant.
    stubFetch(manifest({ jobs: { types: ["jobs:legacy"] } }), { catalogue: catalogueBody() });
    render();
    const box = (await screen.findByRole("checkbox", {
      name: /jobs:legacy/,
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    // An LLM edit makes the save dirty without touching jobs…
    await userEvent.click(await screen.findByRole("checkbox", { name: "claude-opus-4-8" }));
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    // …and the PUT still carries the withdrawn grant.
    await waitFor(() => {
      const capabilities = (lastPut as { capabilities?: Capabilities })?.capabilities;
      expect(capabilities?.llm?.models).toContain("claude-opus-4-8");
      expect(capabilities?.jobs).toEqual({ types: ["jobs:legacy"] });
    });
  });

  it("an unrelated save preserves the advertised and the withdrawn saved types together", async () => {
    stubFetch(manifest({ jobs: { types: ["jobs:fetch", "jobs:legacy"] } }), {
      catalogue: catalogueBody({ types: [FETCH_ENTRY] }),
    });
    render();
    await screen.findByRole("checkbox", { name: /Outbound fetch job/ });
    await userEvent.click(await screen.findByRole("checkbox", { name: "claude-opus-4-8" }));
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    await waitFor(() => {
      const capabilities = (lastPut as { capabilities?: Capabilities })?.capabilities;
      expect(capabilities?.jobs).toEqual({ types: ["jobs:fetch", "jobs:legacy"] });
    });
  });

  it("renders one row per distinct held type — the union is deduped by qualified id", async () => {
    // A hand-authored manifest can carry the same qualified type twice (the
    // manifest parse pins min(1), not uniqueness). The editor's contract is
    // that rows render for the union of advertised and held types deduped by
    // qualified id — so a duplicated held type renders ONE row, and removing
    // it removes the whole (duplicated) value cleanly.
    stubFetch(manifest({ jobs: { types: ["jobs:legacy", "jobs:legacy"] } }), {
      catalogue: catalogueBody(),
    });
    render();
    const rows = await screen.findAllByRole("checkbox", { name: /jobs:legacy/ });
    expect(rows).toHaveLength(1);
    const box = rows[0]! as HTMLInputElement;
    await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    await waitFor(() => {
      const capabilities = (lastPut as { capabilities?: Capabilities })?.capabilities;
      expect(capabilities?.jobs).toBeUndefined();
    });
  });

  it("an advertised and a withdrawn saved type render together; removing the withdrawn one keeps the advertised grant", async () => {
    stubFetch(manifest({ jobs: { types: ["jobs:fetch", "jobs:legacy"] } }), {
      catalogue: catalogueBody({ types: [FETCH_ENTRY] }),
    });
    render();
    // The union: the advertised row renders normally…
    const fetchBox = (await screen.findByRole("checkbox", {
      name: /Outbound fetch job/,
    })) as HTMLInputElement;
    expect(fetchBox.checked).toBe(true);
    // …the withdrawn one beside it, checked and flagged. Exactly one flag —
    // the withdrawn row's — so the advertised row renders unflagged beside it.
    const legacyBox = (await screen.findByRole("checkbox", {
      name: /jobs:legacy/,
    })) as HTMLInputElement;
    expect(legacyBox.checked).toBe(true);
    expect(legacyBox.getAttribute("aria-describedby")).not.toBeNull();
    expect(screen.getByText(/not offered on this deployment/)).toBeDefined();
    expect(screen.queryByText(/Saving removes access to these job types/)).toBeNull();

    await userEvent.click(legacyBox);
    expect(await screen.findByText(/Saving removes access to these job types/)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: /Save manifest/ }));
    await waitFor(() => {
      const capabilities = (lastPut as { capabilities?: Capabilities })?.capabilities;
      expect(capabilities?.jobs).toEqual({ types: ["jobs:fetch"] });
    });
  });
});
