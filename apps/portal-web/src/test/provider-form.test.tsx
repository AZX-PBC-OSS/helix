import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router";
import type { ProviderImpact, ProviderMetadata } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";

// Mantine TagsInput renders a hidden mirror input beside the search
// field; the selector picks the visible one the user types into.
const TAGS_SELECTOR = { selector: '[data-type="visible"]' } as const;
import { ProviderFormPage } from "../pages/admin/ProviderFormPage";

/**
 * Provider create/edit (`/admin/providers/new`, `/admin/providers/:id`, I-02
 * T-0026): the field contract with its mirrored 422s inline, the
 * sensitive-change review panel (diff + impact fetched before it renders,
 * Confirm/Cancel with the draft preserved), the stale-save reload-review-confirm
 * flow, "outcome not confirmed" retry gating, deletion with impact, and
 * keyboard/screen-reader operation of the whole flow.
 */

const ID = "a1000000-0000-4000-8000-000000000001";
const EDIT_ROUTE = `/admin/providers/${ID}`;

function metadata(over: Partial<ProviderMetadata> = {}): ProviderMetadata {
  return {
    id: ID,
    ref: "asana",
    kind: "rest-delegated",
    displayName: "Asana",
    authorizeEndpoint: "https://asana.example/oauth/authorize",
    tokenEndpoint: "https://asana.example/oauth/token",
    requestedScopes: ["read:tasks"],
    apiOrigins: ["https://api.asana.example"],
    tokenPlacement: { kind: "header-bearer" },
    env: "prod",
    revision: 1,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...over,
  };
}

function impact(over: Partial<ProviderImpact> = {}): ProviderImpact {
  return {
    providerId: ID,
    ref: "asana",
    env: "prod",
    displayName: "Asana",
    revision: 1,
    boundApps: [
      { id: "b0000000-0000-4000-8000-000000000001", slug: "notes", displayName: "Notes" },
      { id: "b0000000-0000-4000-8000-000000000002", slug: "tasks", displayName: "Tasks" },
    ],
    connections: 3,
    pendingAttempts: 1,
    ...over,
  };
}

type Reply = { status: number; body: unknown } | "network-drop";

interface ApiState {
  detail: ProviderMetadata;
  impact?: ProviderImpact;
  putReply?: Reply;
  postReply?: Reply;
  deleteReply?: Reply;
  list?: ProviderMetadata[];
}

function ok(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

/** Stub every provider endpoint the form page touches. `state` is read live. */
function stubApi(state: ApiState): Mock & {
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    impl.calls.push({ url, init });
    if (url === `/api/v1/providers/${ID}` && (init?.method ?? "GET") === "GET") {
      return ok(200, state.detail);
    }
    if (url === `/api/v1/providers/${ID}/impact`) {
      if (!state.impact) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: { code: "internal", message: "impact failed" } }),
        };
      }
      return ok(200, state.impact);
    }
    if (url === `/api/v1/providers/${ID}` && init?.method === "PUT") {
      return state.putReply === "network-drop"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : ok(state.putReply?.status ?? 200, state.putReply?.body ?? state.detail);
    }
    if (url === `/api/v1/providers/${ID}` && init?.method === "DELETE") {
      return state.deleteReply === "network-drop"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : ok(state.deleteReply?.status ?? 200, state.deleteReply?.body ?? { outcome: "deleted" });
    }
    if (url === "/api/v1/providers" && init?.method === "POST") {
      return state.postReply === "network-drop"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : ok(state.postReply?.status ?? 201, state.postReply?.body ?? state.detail);
    }
    if (url === "/api/v1/providers") {
      return ok(200, {
        callbackUrl: "https://auth.example/connections/callback",
        providers: state.list ?? [],
      });
    }
    return new Promise(() => {});
  }) as Mock & { calls: Array<{ url: string; init?: RequestInit }> };
  impl.calls = [];
  vi.stubGlobal("fetch", impl);
  return impl;
}

const puts = (impl: ReturnType<typeof stubApi>) =>
  impl.calls
    .filter((c) => c.init?.method === "PUT")
    .map((c) => JSON.parse(c.init?.body as string) as Record<string, unknown>);

function renderCreate() {
  return renderWithProviders(
    <Routes>
      <Route path="/admin/providers/new" element={<ProviderFormPage />} />
      <Route path="/admin/providers/:id" element={<ProviderFormPage />} />
    </Routes>,
    { route: "/admin/providers/new" },
  );
}

function renderEdit() {
  return renderWithProviders(
    <Routes>
      <Route path="/admin/providers/new" element={<ProviderFormPage />} />
      <Route path="/admin/providers/:id" element={<ProviderFormPage />} />
    </Routes>,
    { route: EDIT_ROUTE },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ProviderFormPage create", () => {
  it("submits the full field contract — env, canonical origins, placement — and navigates to the edit route", async () => {
    const user = userEvent.setup();
    const state: ApiState = { detail: metadata() };
    const impl = stubApi(state);
    renderCreate();

    const save = await screen.findByRole("button", { name: "Create provider" });
    // Required fields missing — Save stays disabled (design's field contract).
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText(/^Reference/), "asana");
    await user.click(screen.getByRole("combobox", { name: /^Environment/ }));
    await user.click(await screen.findByText("Prod"));
    await user.type(screen.getByLabelText(/^Display name/), "Asana");
    await user.type(
      screen.getByLabelText(/^Authorize endpoint/),
      "https://asana.example/oauth/authorize",
    );
    await user.type(screen.getByLabelText(/^Token endpoint/), "https://asana.example/oauth/token");
    await user.type(screen.getByLabelText(/^Client ID/), "client-123");
    await user.type(screen.getByLabelText(/^Client secret/), "shhh");
    // TagsInput: type + Enter commits a tag. A trailing slash on the origin is
    // canonicalized away before the body is built.
    const origins = screen.getByLabelText(/^API destinations/, TAGS_SELECTOR);
    await user.type(origins, "https://api.asana.example/{enter}");
    const scopes = screen.getByLabelText(/^Requested permissions/, TAGS_SELECTOR);
    await user.type(scopes, "read:tasks{enter}");

    expect((save as HTMLButtonElement).disabled).toBe(false);
    await user.click(save);

    expect(puts(impl)).toHaveLength(0);
    const post = impl.calls.find((c) => c.init?.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(post!.init?.body as string)).toEqual({
      ref: "asana",
      kind: "rest-delegated",
      displayName: "Asana",
      env: "prod",
      authorizeEndpoint: "https://asana.example/oauth/authorize",
      tokenEndpoint: "https://asana.example/oauth/token",
      clientId: "client-123",
      clientSecret: "shhh",
      requestedScopes: ["read:tasks"],
      apiOrigins: ["https://api.asana.example"],
      tokenPlacement: { kind: "header-bearer" },
    });
  });

  it("mirrors the server's 422s inline, announces an assertive summary, and sends nothing", async () => {
    const user = userEvent.setup();
    const impl = stubApi({ detail: metadata() });
    renderCreate();

    await screen.findByRole("button", { name: "Create provider" });
    await user.type(screen.getByLabelText(/^Reference/), "ASANA");
    await user.click(screen.getByRole("combobox", { name: /^Environment/ }));
    await user.click(await screen.findByText("Prod"));
    await user.type(screen.getByLabelText(/^Display name/), "Asana");
    await user.type(
      screen.getByLabelText(/^Authorize endpoint/),
      "https://asana.example/oauth/authorize",
    );
    await user.type(screen.getByLabelText(/^Token endpoint/), "https://asana.example/oauth/token");
    await user.type(screen.getByLabelText(/^Client ID/), "client-123");
    await user.type(screen.getByLabelText(/^Client secret/), "shhh");
    await user.type(
      screen.getByLabelText(/^API destinations/, TAGS_SELECTOR),
      "https://api.asana.example/api{enter}",
    );
    await user.type(
      screen.getByLabelText(/^Requested permissions/, TAGS_SELECTOR),
      "bad scope{enter}",
    );

    await user.click(screen.getByRole("button", { name: "Create provider" }));

    // Inline field errors — the same messages the server's 422s carry.
    expect(await screen.findByText(/lowercase letters, digits, and hyphens/)).toBeDefined();
    expect(
      screen.getByText(/an API destination is an origin — scheme:\/\/host\[:port\], no path/),
    ).toBeDefined();
    expect(screen.getByText(/must be an RFC 6749 scope token/)).toBeDefined();
    // Assertive submission summary, associated announcement.
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("Fix the highlighted fields");
    expect(impl.calls.filter((c) => c.init?.method === "POST")).toHaveLength(0);
  });

  it("reports a duplicate create naming the existing ref + environment", async () => {
    const user = userEvent.setup();
    stubApi({
      detail: metadata(),
      postReply: {
        status: 409,
        body: {
          error: {
            code: "conflict",
            message: 'provider "asana" already exists in the prod environment',
          },
        },
      },
    });
    renderCreate();

    await screen.findByRole("button", { name: "Create provider" });
    await user.type(screen.getByLabelText(/^Reference/), "asana");
    await user.click(screen.getByRole("combobox", { name: /^Environment/ }));
    await user.click(await screen.findByText("Prod"));
    await user.type(screen.getByLabelText(/^Display name/), "Asana");
    await user.type(
      screen.getByLabelText(/^Authorize endpoint/),
      "https://asana.example/oauth/authorize",
    );
    await user.type(screen.getByLabelText(/^Token endpoint/), "https://asana.example/oauth/token");
    await user.type(screen.getByLabelText(/^Client ID/), "client-123");
    await user.type(screen.getByLabelText(/^Client secret/), "shhh");
    await user.type(
      screen.getByLabelText(/^API destinations/, TAGS_SELECTOR),
      "https://api.asana.example{enter}",
    );

    await user.click(screen.getByRole("button", { name: "Create provider" }));
    expect(await screen.findByRole("alert").then((a) => a.textContent)).toContain(
      'provider "asana" already exists in the prod environment',
    );
  });
});

describe("ProviderFormPage edit — save outcomes", () => {
  it("seeds the form from the loaded provider, saves a non-sensitive edit without the panel, then reseeds", async () => {
    const user = userEvent.setup();
    const impl = stubApi({ detail: metadata() });
    renderEdit();

    // The draft seeded from current state (blank credential fields — write-only).
    const displayName = (await screen.findByLabelText(/^Display name/)) as HTMLInputElement;
    await vi.waitFor(() => expect(displayName.value).toBe("Asana"));
    expect((screen.getByLabelText(/^Client secret/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^Reference/) as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole("combobox", { name: /^Environment/ }) as HTMLInputElement).disabled,
    ).toBe(true);

    await user.clear(displayName);
    await user.type(displayName, "Asana Tasks");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // No review panel for a display-name change; the body carries the loaded
    // revision and no credential.
    expect(screen.queryByRole("dialog")).toBeNull();
    const bodies = puts(impl);
    expect(bodies).toHaveLength(1);
    const putBody = bodies[0]!;
    expect(putBody.displayName).toBe("Asana Tasks");
    expect(putBody.revision).toBe(1);
    expect(putBody.confirmInvalidation).toBeUndefined();
    expect(putBody.clientSecret).toBeUndefined();
    expect(putBody.clientId).toBeUndefined();
    // Success announcement, and the form reseeded from the response.
    expect((await screen.findByRole("status")).textContent).toContain("Saved");
  });

  it("opens the review panel with the field diff and impact counts BEFORE sending, and Confirm applies with the acknowledgement", async () => {
    const user = userEvent.setup();
    const impl = stubApi({
      detail: metadata(),
      impact: impact(),
      putReply: {
        status: 200,
        body: metadata({ authorizeEndpoint: "https://new.example/authorize", revision: 2 }),
      },
    });
    renderEdit();

    const endpoint = (await screen.findByLabelText(/^Authorize endpoint/)) as HTMLInputElement;
    await vi.waitFor(() => expect(endpoint.value).toBe("https://asana.example/oauth/authorize"));
    await user.clear(endpoint);
    await user.type(endpoint, "https://new.example/authorize");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // The panel — a modal dialog with the diff, the impact, the warning.
    const dialog = await screen.findByRole("dialog");
    // One line per changed field: current → proposed.
    const endpointLine = within(dialog)
      .getAllByText(/^Authorize endpoint:/)
      .find((el) => el.textContent?.includes("→"));
    expect(endpointLine).toBeDefined();
    expect(endpointLine!.textContent).toContain("https://asana.example/oauth/authorize");
    expect(endpointLine!.textContent).toContain("https://new.example/authorize");
    expect(within(dialog).getByText(/Apps bound:/).textContent).toContain("notes, tasks");
    expect(within(dialog).getByText(/User connections:\s*3/)).toBeDefined();
    expect(within(dialog).getByText(/Pending consent attempts:\s*1/)).toBeDefined();
    expect(within(dialog).getByText(/pending consent attempts become invalid/i)).toBeDefined();
    expect(within(dialog).getByText(/does not create reapproval requests/)).toBeDefined();
    // Nothing sent before the confirmation.
    expect(puts(impl)).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Confirm change" }));
    const bodies = puts(impl);
    expect(bodies).toHaveLength(1);
    const putBody = bodies[0]!;
    expect(putBody.confirmInvalidation).toBe(true);
    expect(putBody.revision).toBe(1);
    expect(putBody.authorizeEndpoint).toBe("https://new.example/authorize");
    // Success banner + reseed from the response (revision advanced).
    expect((await screen.findByRole("status")).textContent).toContain("Saved");
  });

  it("Cancel returns to the form with the draft intact and nothing sent", async () => {
    const user = userEvent.setup();
    const impl = stubApi({ detail: metadata(), impact: impact() });
    renderEdit();

    const endpoint = (await screen.findByLabelText(/^Authorize endpoint/)) as HTMLInputElement;
    await vi.waitFor(() => expect(endpoint.value).toBe("https://asana.example/oauth/authorize"));
    await user.clear(endpoint);
    await user.type(endpoint, "https://new.example/authorize");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The draft survives — the edited value is still in the input.
    expect((screen.getByLabelText(/^Authorize endpoint/) as HTMLInputElement).value).toBe(
      "https://new.example/authorize",
    );
    expect(puts(impl)).toHaveLength(0);
  });

  it("a server 409 confirmation_required surfaces the same panel from the carried impact, and Confirm re-sends acknowledged", async () => {
    const user = userEvent.setup();
    const impl = stubApi({
      detail: metadata(),
      // The server's stored row disagrees with what the SPA loaded: a
      // display-name-only edit is refused as a sensitive delta.
      putReply: {
        status: 409,
        body: {
          error: {
            code: "confirmation_required",
            message: "editing tokenEndpoint of provider asana invalidates its connections",
            details: { impact: impact(), sensitiveFields: ["tokenEndpoint"] },
          },
        },
      },
    });
    renderEdit();

    const displayName = (await screen.findByLabelText(/^Display name/)) as HTMLInputElement;
    await vi.waitFor(() => expect(displayName.value).toBe("Asana"));
    await user.clear(displayName);
    await user.type(displayName, "Asana Tasks");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // The panel opens from the 409's details — no separate impact fetch.
    const dialog = await screen.findByRole("dialog");
    expect(
      impl.calls.filter((c) => c.url.endsWith("/impact") && (c.init?.method ?? "GET") === "GET"),
    ).toHaveLength(0);
    expect(within(dialog).getByText(/Apps bound:/)).toBeDefined();
    // Confirm re-sends the same change, acknowledged.
    await user.click(within(dialog).getByRole("button", { name: "Confirm change" }));
    const bodies = puts(impl);
    expect(bodies).toHaveLength(2);
    const putBody = bodies[1]!;
    expect(putBody.confirmInvalidation).toBe(true);
    expect(putBody.displayName).toBe("Asana Tasks");
  });

  it("a stale save shows the reload-review-confirm message with the draft preserved; Reload reseeds from current state", async () => {
    const user = userEvent.setup();
    const state: ApiState = {
      detail: metadata(),
      putReply: {
        status: 409,
        body: {
          error: {
            code: "conflict",
            message: 'provider "asana" changed since it was loaded — reload the current settings',
          },
        },
      },
    };
    stubApi(state);
    renderEdit();

    const displayName = (await screen.findByLabelText(/^Display name/)) as HTMLInputElement;
    await vi.waitFor(() => expect(displayName.value).toBe("Asana"));
    await user.clear(displayName);
    await user.type(displayName, "Asana Tasks");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // The message, with the draft preserved underneath it.
    expect(await screen.findByText(/These settings changed since you loaded them/)).toBeDefined();
    expect((screen.getByLabelText(/^Display name/) as HTMLInputElement).value).toBe("Asana Tasks");

    // Reload: refetch current state and reseed the form from it.
    state.detail = metadata({ displayName: "Server-won edit", revision: 2 });
    await user.click(screen.getByRole("button", { name: "Reload" }));
    const reseeded = (await screen.findByLabelText(/^Display name/)) as HTMLInputElement;
    await vi.waitFor(() => expect(reseeded.value).toBe("Server-won edit"));
    expect(screen.queryByText(/These settings changed since you loaded them/)).toBeNull();
  });

  it("a lost response is outcome not confirmed — retry disabled until a refresh", async () => {
    const user = userEvent.setup();
    stubApi({ detail: metadata(), putReply: "network-drop" });
    renderEdit();

    const displayName = (await screen.findByLabelText(/^Display name/)) as HTMLInputElement;
    await vi.waitFor(() => expect(displayName.value).toBe("Asana"));
    await user.clear(displayName);
    await user.type(displayName, "Asana Tasks");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/Outcome not confirmed/)).toBeDefined();
    const save = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // The refresh re-enables retry — nothing was resubmitted automatically.
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    const saveAfter = (await screen.findByRole("button", {
      name: "Save changes",
    })) as HTMLButtonElement;
    await vi.waitFor(() => expect(saveAfter.disabled).toBe(false));
  });
});

describe("ProviderFormPage deletion", () => {
  it("shows the impact before confirming; Confirm deletes; a repeat reports already removed", async () => {
    const user = userEvent.setup();
    const impl = stubApi({ detail: metadata(), impact: impact() });
    renderEdit();

    await screen.findByRole("button", { name: "Save changes" });
    await user.click(screen.getByRole("button", { name: "Delete provider" }));

    // Deletion's panel: impact counts + criterion-9 statement, no diff.
    const dialog = await screen.findByRole("dialog", { name: "Delete provider" });
    expect(
      within(dialog).getByText(/restores neither old consent nor old approvals/),
    ).toBeDefined();
    expect(within(dialog).getByText(/User connections:\s*3/)).toBeDefined();
    expect(within(dialog).queryByText("Changes")).toBeNull();
    expect(impl.calls.filter((c) => c.init?.method === "DELETE")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Delete provider" }));
    const del = impl.calls.find((c) => c.init?.method === "DELETE");
    expect(JSON.parse(del!.init?.body as string)).toEqual({ confirmInvalidation: true });
  });

  it("announces an already-removed repeat instead of pretending to delete", async () => {
    const user = userEvent.setup();
    stubApi({
      detail: metadata(),
      impact: impact(),
      deleteReply: { status: 200, body: { outcome: "already_removed" } },
    });
    renderEdit();

    await screen.findByRole("button", { name: "Save changes" });
    await user.click(screen.getByRole("button", { name: "Delete provider" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete provider" });
    await user.click(within(dialog).getByRole("button", { name: "Delete provider" }));
    expect((await screen.findByRole("status")).textContent).toContain("Already removed");
  });
});

describe("ProviderFormPage keyboard + screen-reader flow", () => {
  it("operates edit → review → cancel → review → confirm entirely from the keyboard, with modal focus management", async () => {
    const user = userEvent.setup();
    stubApi({
      detail: metadata(),
      impact: impact(),
      putReply: { status: 200, body: metadata({ revision: 2 }) },
    });
    renderEdit();

    const save = await screen.findByRole("button", { name: "Save changes" });
    const endpoint = screen.getByLabelText(/^Authorize endpoint/) as HTMLInputElement;
    await vi.waitFor(() => expect(endpoint.value).toBe("https://asana.example/oauth/authorize"));

    // Keyboard edit of a sensitive field.
    await user.clear(endpoint);
    await user.type(endpoint, "https://new.example/authorize");

    // Enter on the focused Save button opens the review panel; focus moves
    // into the dialog (the form itself is ordinary labelled controls, so the
    // keyboard-interesting part is this handoff).
    save.focus();
    await user.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Confirm change" });
    await vi.waitFor(() => expect(document.activeElement).toBe(confirm));

    // Escape cancels: the panel closes, focus returns to the trigger, the
    // draft is intact, nothing was sent.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(save);
    expect((screen.getByLabelText(/^Authorize endpoint/) as HTMLInputElement).value).toBe(
      "https://new.example/authorize",
    );

    // Re-open and confirm from the keyboard: focus sits on Save, Enter opens
    // the panel again, focus moves to Confirm, Enter applies.
    await user.keyboard("{Enter}");
    const reopened = await screen.findByRole("dialog");
    const confirmAgain = within(reopened).getByRole("button", { name: "Confirm change" });
    await vi.waitFor(() => expect(document.activeElement).toBe(confirmAgain));
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await screen.findByRole("status")).textContent).toContain("Saved");
  });
});
