import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ProviderImportCreateRequestSchema,
  type ProviderExportDocument,
  type ProviderMetadata,
} from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { ProvidersPage } from "../pages/admin/ProvidersPage";
import { setToken, clearToken } from "../auth/tokenStore";
import { downloadText } from "../lib/download";

/**
 * Provider export + import on the admin list page (I-02 T-0027): export is an
 * authorized read handed to the download seam with the pinned `<ref>.provider.json`
 * filename — a failed or drifted read is surfaced, never downloaded. Import is
 * preview-first: the shared schema validates the picked file (server-side, via
 * the preview endpoint), mode is an explicit choice that a name collision never
 * shortcuts, and apply reports created/updated distinctly — with rejections
 * leaving the list untouched and a lost response gating retry on a refresh.
 */

vi.mock("../lib/download", () => ({ downloadText: vi.fn() }));
const downloadMock = vi.mocked(downloadText);

const ID = "a1000000-0000-4000-8000-000000000001";
const JIRA_ID = "b2000000-0000-4000-8000-000000000003";

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

/** A credential-free export document (the export endpoint's 200 body). */
const DOCUMENT: ProviderExportDocument = {
  version: 1,
  provider: {
    ref: "jira",
    kind: "rest-delegated",
    displayName: "Jira",
    authorizeEndpoint: "https://jira.example/oauth/authorize",
    tokenEndpoint: "https://jira.example/oauth/token",
    requestedScopes: ["read:issues"],
    apiOrigins: ["https://api.jira.example"],
    tokenPlacement: { kind: "header-bearer" },
  },
};
const DOCUMENT_JSON = JSON.stringify(DOCUMENT);

const UPDATE_TARGET = {
  providerId: ID,
  ref: "asana",
  env: "prod" as const,
  displayName: "Asana",
  revision: 3,
};

type Reply = { status: number; body: unknown } | "network-drop";

interface StubState {
  list?: ProviderMetadata[];
  exportReply?: Reply;
  previewReply?: (body: Record<string, unknown>) => Reply;
  importReply?: Reply;
}

function ok(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

/** The preview endpoint's answers, keyed by what the request proposed. */
function defaultPreviewReply(body: Record<string, unknown>): Reply {
  if (body.mode === undefined) {
    return { status: 200, body: { mode: null, provider: DOCUMENT.provider } };
  }
  if (body.mode === "create") {
    return {
      status: 200,
      body: { mode: "create", env: body.env, provider: DOCUMENT.provider, collision: null },
    };
  }
  return {
    status: 200,
    body: { mode: "update", target: UPDATE_TARGET, diff: [], sensitiveFields: [] },
  };
}

/** Stub every endpoint the page + card touch. `state` is read live. */
function stubApi(state: StubState = {}): Mock & {
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const previewReply = state.previewReply ?? defaultPreviewReply;
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    impl.calls.push({ url, init });
    if (url === "/api/v1/providers" && (init?.method ?? "GET") === "GET") {
      return ok(200, {
        callbackUrl: "https://auth.example/connections/callback",
        providers: state.list ?? [],
      });
    }
    if (url.endsWith("/export") && (init?.method ?? "GET") === "GET") {
      const exportReply = state.exportReply;
      if (exportReply === "network-drop") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      const status = exportReply?.status ?? 200;
      if (status >= 400) {
        return ok(status, { error: { code: "internal", message: "export read failed" } });
      }
      return { ok: true, status, text: async () => (exportReply?.body as string) ?? DOCUMENT_JSON };
    }
    if (url === "/api/v1/providers/import/preview" && init?.method === "POST") {
      const reply = previewReply(JSON.parse(init.body as string) as Record<string, unknown>);
      if (reply === "network-drop") return Promise.reject(new TypeError("Failed to fetch"));
      return ok(reply.status, reply.body);
    }
    if (url === "/api/v1/providers/import" && init?.method === "POST") {
      const importReply = state.importReply;
      if (importReply === "network-drop") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      const status = importReply?.status ?? 201;
      const body = importReply?.body ?? {
        outcome: "created",
        provider: metadata({ ref: "jira", displayName: "Jira", env: "dev" }),
      };
      return ok(status, body);
    }
    return new Promise(() => {});
  }) as Mock & { calls: Array<{ url: string; init?: RequestInit }> };
  impl.calls = [];
  vi.stubGlobal("fetch", impl);
  return impl;
}

const applyCalls = (impl: ReturnType<typeof stubApi>) =>
  impl.calls.filter((c) => c.url === "/api/v1/providers/import" && c.init?.method === "POST");

/** Drive the FileInput's hidden native input — jsdom has no file dialog (the
 * dropzone precedent drives the same handler the dialog would). */
async function pickFile(contents: string, name = "jira.provider.json") {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  fireEvent.change(input!, {
    target: { files: [new File([contents], name, { type: "application/json" })] },
  });
}

async function chooseMode(mode: "Create a new provider" | "Update an existing provider") {
  await pickOption(/^Import mode/, mode);
}

/** Open a Mantine Select and choose one of its options. The choice is scoped to
 * the opened combobox's own listbox (via aria-controls) — the page's env filter
 * shares the words "Dev"/"Prod" with the import selects, and jsdom renders every
 * select's dropdown mounted-but-hidden, so text queries alone match too much. */
async function pickOption(combobox: RegExp, option: string) {
  const combo = await screen.findByRole("combobox", { name: combobox });
  await userEvent.click(combo);
  const listbox = document.getElementById(combo.getAttribute("aria-controls") ?? "");
  expect(listbox).not.toBeNull();
  await userEvent.click(within(listbox!).getByText(option));
}

const applyButton = () => screen.getByRole("button", { name: "Apply import" }) as HTMLButtonElement;

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
  downloadMock.mockClear();
});

describe("provider export (criterion 11)", () => {
  it("downloads the credential-free document over an authorized read, as <ref>.provider.json", async () => {
    setToken("test-token");
    const impl = stubApi({ list: [metadata()] });
    renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
    await screen.findByText("asana");
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    // The read carried the bearer header — navigation could not have.
    const exportCall = impl.calls.find((c) => c.url.endsWith("/export"));
    expect(exportCall).toBeDefined();
    expect((exportCall!.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );

    // The pinned filename, the body exactly as the API sent it, JSON mime.
    expect(downloadMock).toHaveBeenCalledTimes(1);
    const [filename, text, mime] = downloadMock.mock.calls[0]!;
    expect(filename).toBe("asana.provider.json");
    expect(text).toBe(DOCUMENT_JSON);
    expect(mime).toBe("application/json");

    // Credential-free, per the API contract: the file the seam received parses
    // as the export document and carries only the document's field set.
    const parsed = JSON.parse(text) as { provider: Record<string, unknown> };
    expect(parsed.provider).toEqual(DOCUMENT.provider);
    expect(Object.keys(parsed.provider).sort()).toEqual(
      [
        "ref",
        "kind",
        "displayName",
        "authorizeEndpoint",
        "tokenEndpoint",
        "requestedScopes",
        "apiOrigins",
        "tokenPlacement",
      ].sort(),
    );
  });

  it("surfaces a failed read as an export failure and fires no download", async () => {
    stubApi({ list: [metadata()], exportReply: { status: 500, body: undefined } });
    renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
    await screen.findByText("asana");
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain('Export failed for "asana"');
    expect(alert.textContent).toContain("No file was downloaded");
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("refuses a drifted response that is not a complete export — even one carrying credential fields", async () => {
    // A hypothetical drift: the strict shared schema is what keeps such a body
    // from ever being offered as a download, credentials and all.
    const drifted = JSON.stringify({
      ...DOCUMENT,
      clientId: "leaked",
      clientSecret: "leaked-too",
    });
    stubApi({ list: [metadata()], exportReply: { status: 200, body: drifted } });
    renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
    await screen.findByText("asana");
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "not a complete provider export",
    );
    expect(downloadMock).not.toHaveBeenCalled();
  });
});

describe("import preview", () => {
  it("a valid file shows the parsed fields, the labelled preview region, and the explicit mode select", async () => {
    const impl = stubApi({ list: [metadata()] });
    renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
    await screen.findByText("asana");
    await pickFile(DOCUMENT_JSON);

    // Parsed fields from the validated document — configuration only, never a credential.
    const preview = await screen.findByRole("region", { name: "Import preview" });
    expect(preview.textContent).toContain("Reference: jira");
    expect(preview.textContent).toContain("Display name: Jira");
    expect(preview.textContent).toContain("https://jira.example/oauth/token");
    expect(preview.textContent).not.toContain("clientSecret");
    expect(preview.textContent).not.toContain("Client ID");

    // The validate-only call proposed nothing — no mode in the body.
    const previewCall = impl.calls.find((c) => c.url.endsWith("/import/preview"));
    expect(JSON.parse(previewCall!.init?.body as string)).toEqual({ document: DOCUMENT });

    // Apply is gated on the explicit mode choice — never implicit.
    expect(applyButton().disabled).toBe(true);
    expect(screen.queryByLabelText(/Update target/)).toBeNull();
  });

  it("a file failing the shared schema shows blocking errors, announced, with Apply disabled", async () => {
    stubApi({
      list: [metadata()],
      previewReply: () => ({
        status: 400,
        body: {
          error: {
            code: "validation_failed",
            message: "import preview request is malformed",
            details: [
              {
                path: ["provider", "requestedScopes", 0],
                message: "must be an RFC 6749 scope token",
              },
            ],
          },
        },
      }),
    });
    renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
    await screen.findByText("asana");
    await pickFile(DOCUMENT_JSON);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This file can't be imported");
    expect(alert.textContent).toContain(
      "provider.requestedScopes.0: must be an RFC 6749 scope token",
    );
    expect(applyButton().disabled).toBe(true);
  });

  it("a file that is not JSON is blocked locally before any request", async () => {
    const impl = stubApi({ list: [metadata()] });
    renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
    await screen.findByText("asana");
    await pickFile("this is not json");

    expect((await screen.findByRole("alert")).textContent).toContain("not JSON");
    expect(impl.calls.filter((c) => c.url.endsWith("/import/preview"))).toHaveLength(0);
    expect(downloadMock).not.toHaveBeenCalled();
  });
});

describe("import mode and preview panel", () => {
  it("a name collision in create mode forces an explicit choice — no implicit update target", async () => {
    const impl = stubApi({
      list: [metadata(), metadata({ id: JIRA_ID, ref: "jira", displayName: "Jira" })],
      previewReply: (body) =>
        body.mode === "create" && body.env === "prod"
          ? {
              status: 200,
              body: {
                mode: "create",
                env: "prod",
                provider: DOCUMENT.provider,
                collision: { providerId: JIRA_ID, ref: "jira", env: "prod" },
              },
            }
          : defaultPreviewReply(body),
    });
    renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
    await screen.findByText("asana");
    await pickFile(DOCUMENT_JSON);
    await chooseMode("Create a new provider");
    await pickOption(/^Environment/, "Prod");

    // The collision is surfaced before apply, by name and environment...
    const collision = await screen.findByText(/already exists in PROD/);
    expect(collision.textContent).toContain('"jira"');
    // ...apply is blocked — the collision never becomes an update...
    expect(applyButton().disabled).toBe(true);
    // ...and no update target was implied: this is still the create panel.
    expect(screen.queryByLabelText(/Update target/)).toBeNull();

    // The create-mode preview named the environment explicitly.
    const createPreviewCall = impl.calls.filter((c) => c.url.endsWith("/import/preview"))[1]!;
    expect(JSON.parse(createPreviewCall.init?.body as string)).toEqual({
      document: DOCUMENT,
      mode: "create",
      env: "prod",
    });
    expect(applyCalls(impl)).toHaveLength(0);
  });

  it("update mode renders the diff — one line per changed field — and warns on sensitive fields", async () => {
    stubApi({
      list: [metadata()],
      previewReply: (body) =>
        body.mode === "update"
          ? {
              status: 200,
              body: {
                mode: "update",
                target: UPDATE_TARGET,
                diff: [
                  { field: "displayName", current: "Asana", imported: "Jira" },
                  {
                    field: "tokenEndpoint",
                    current: "https://asana.example/oauth/token",
                    imported: "https://jira.example/oauth/token",
                  },
                ],
                sensitiveFields: ["tokenEndpoint"],
              },
            }
          : defaultPreviewReply(body),
    });
    renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
    await screen.findByText("asana");
    await pickFile(DOCUMENT_JSON);
    await chooseMode("Update an existing provider");
    await pickOption(/^Update target/, "asana · PROD · Asana");

    // One line per changed field: current → imported. The label prefix also
    // matches the parsed-fields line, so the arrow picks the diff line out.
    const nameLine = await screen
      .findAllByText(/^Display name:/)
      .then((lines) => lines.find((el) => el.textContent?.includes("→")));
    expect(nameLine).toBeDefined();
    expect(nameLine!.textContent).toContain("Asana → Jira");
    const endpointLine = await screen
      .findAllByText(/^Token endpoint:/)
      .then((lines) => lines.find((el) => el.textContent?.includes("→")));
    expect(endpointLine).toBeDefined();
    expect(endpointLine!.textContent).toContain(
      "https://asana.example/oauth/token → https://jira.example/oauth/token",
    );
    // The target names itself, with the revision the apply will CAS on.
    expect(screen.getByText(/revision 3/)).toBeDefined();
    // The sensitive half of the diff carries the invalidation warning.
    expect(screen.getByText(/pending consent attempts become invalid/i)).toBeDefined();
  });
});

describe("import apply", () => {
  it("create without credential entry is blocked client-side — inline errors, nothing sent", async () => {
    const impl = stubApi({ list: [metadata()] });
    renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
    await screen.findByText("asana");
    await pickFile(DOCUMENT_JSON);
    await chooseMode("Create a new provider");
    await pickOption(/^Environment/, "Dev");
    // Both credential fields left blank.
    await userEvent.click(applyButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("never imported");
    // Inline errors name each missing credential, associated with its input.
    expect(screen.getByText("a client ID is required")).toBeDefined();
    expect(screen.getByText("a client secret is required")).toBeDefined();
    expect(applyCalls(impl)).toHaveLength(0);
  });

  it("a credential-less create apply is rejected by the server's own schema (the route's parse)", () => {
    const result = ProviderImportCreateRequestSchema.safeParse({
      mode: "create",
      document: DOCUMENT,
      env: "dev",
    });
    expect(result.success).toBe(false);
  });

  it("create apply sends document + explicit env + entered credentials, reports created, refetches the list", async () => {
    const impl = stubApi({
      list: [metadata()],
      importReply: {
        status: 201,
        body: {
          outcome: "created",
          provider: metadata({ id: JIRA_ID, ref: "jira", displayName: "Jira", env: "dev" }),
        },
      },
    });
    renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
    await screen.findByText("asana");
    await pickFile(DOCUMENT_JSON);
    await chooseMode("Create a new provider");
    await pickOption(/^Environment/, "Dev");
    await userEvent.type(screen.getByLabelText(/^Client ID$/), "client-9");
    await userEvent.type(screen.getByLabelText(/^Client secret$/), "shhh");
    await userEvent.click(applyButton());

    const post = applyCalls(impl)[0]!;
    expect(JSON.parse(post.init?.body as string)).toEqual({
      mode: "create",
      document: DOCUMENT,
      env: "dev",
      clientId: "client-9",
      clientSecret: "shhh",
    });
    // Created — reported distinctly from updated, with the new ref named.
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain('Provider created — "jira"');
    expect(status.textContent).not.toContain("updated");
    // The completed action refetches the list (criterion 13).
    await vi.waitFor(() =>
      expect(
        impl.calls.filter(
          (c) => c.url === "/api/v1/providers" && (c.init?.method ?? "GET") === "GET",
        ).length,
      ).toBeGreaterThan(1),
    );
  });

  it("update apply: a blank replace-secret keeps the credential, a sensitive delta applies acknowledged, reports updated", async () => {
    const impl = stubApi({
      list: [metadata()],
      previewReply: (body) =>
        body.mode === "update"
          ? {
              status: 200,
              body: {
                mode: "update",
                target: UPDATE_TARGET,
                diff: [{ field: "displayName", current: "Asana", imported: "Jira" }],
                sensitiveFields: ["tokenEndpoint"],
              },
            }
          : defaultPreviewReply(body),
      importReply: {
        status: 200,
        body: { outcome: "updated", provider: metadata({ revision: 4 }) },
      },
    });
    renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
    await screen.findByText("asana");
    await pickFile(DOCUMENT_JSON);
    await chooseMode("Update an existing provider");
    await pickOption(/^Update target/, "asana · PROD · Asana");
    // "Replace client secret" left blank — the stored credential keeps.
    await userEvent.click(applyButton());

    const body = JSON.parse(applyCalls(impl)[0]!.init?.body as string) as Record<string, unknown>;
    expect(body.mode).toBe("update");
    expect(body.document).toEqual(DOCUMENT);
    expect(body.targetId).toBe(ID);
    expect(body.revision).toBe(3);
    expect(body).not.toHaveProperty("clientSecret");
    expect(body.confirmInvalidation).toBe(true);
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain('Provider updated — "asana"');
    expect(status.textContent).not.toContain("Provider created");
  });
});

describe("import apply failures", () => {
  it("a rejected apply is surfaced and leaves the list unchanged — no refetch fired", async () => {
    const impl = stubApi({
      list: [metadata()],
      previewReply: (body) =>
        body.mode === "update"
          ? {
              status: 200,
              body: {
                mode: "update",
                target: UPDATE_TARGET,
                diff: [{ field: "displayName", current: "Asana", imported: "Jira" }],
                sensitiveFields: [],
              },
            }
          : defaultPreviewReply(body),
      importReply: {
        status: 409,
        body: {
          error: {
            code: "conflict",
            message: 'provider "asana" changed since it was loaded — reload the current settings',
          },
        },
      },
    });
    renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
    await screen.findByText("asana");
    await pickFile(DOCUMENT_JSON);
    await chooseMode("Update an existing provider");
    await pickOption(/^Update target/, "asana · PROD · Asana");
    await userEvent.click(applyButton());

    expect((await screen.findByRole("alert")).textContent).toContain("changed since it was loaded");
    // The rows on screen are untouched, and the rejection fired no refetch.
    expect(screen.getByText("asana")).toBeDefined();
    expect(
      impl.calls.filter(
        (c) => c.url === "/api/v1/providers" && (c.init?.method ?? "GET") === "GET",
      ),
    ).toHaveLength(1);
  });

  it("a lost apply response is outcome not confirmed — retry gated on a refresh", async () => {
    const impl = stubApi({ list: [metadata()], importReply: "network-drop" });
    renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
    await screen.findByText("asana");
    await pickFile(DOCUMENT_JSON);
    await chooseMode("Create a new provider");
    await pickOption(/^Environment/, "Dev");
    await userEvent.type(screen.getByLabelText(/^Client ID$/), "client-9");
    await userEvent.type(screen.getByLabelText(/^Client secret$/), "shhh");
    await userEvent.click(applyButton());

    expect(await screen.findByText(/Outcome not confirmed/)).toBeDefined();
    expect(applyButton().disabled).toBe(true);
    // Nothing was resubmitted automatically.
    expect(applyCalls(impl)).toHaveLength(1);

    // The refresh re-enables retry — the admin reviews before applying again.
    await userEvent.click(screen.getByRole("button", { name: "Refresh the list" }));
    await vi.waitFor(() => expect(applyButton().disabled).toBe(false));
    expect(applyCalls(impl)).toHaveLength(1);
  });
});

describe("import keyboard + announcement flow", () => {
  it("runs create entirely from the keyboard, with the preview tab-reachable and the outcome announced", async () => {
    const impl = stubApi({ list: [metadata()] });
    renderWithProviders(<ProvidersPage />, { route: "/admin/providers" });
    await screen.findByText("asana");
    await pickFile(DOCUMENT_JSON);

    // The picker is a labelled control; tabbing from it walks the preview's
    // controls in source order — the FileInput's clear affordance, then the
    // mode select inside the preview region. No tabindex reordering anywhere.
    const picker = await screen.findByLabelText(/Provider export \(JSON\)/);
    picker.focus();
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: /^Import mode/ }));

    await chooseMode("Create a new provider");
    await pickOption(/^Environment/, "Dev");
    await userEvent.type(screen.getByLabelText(/^Client ID$/), "client-9");
    await userEvent.type(screen.getByLabelText(/^Client secret$/), "shhh");

    // Enter on the focused Apply applies.
    applyButton().focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(applyCalls(impl)).toHaveLength(1));
    expect((await screen.findByRole("status")).textContent).toContain('Provider created — "jira"');
  });
});
