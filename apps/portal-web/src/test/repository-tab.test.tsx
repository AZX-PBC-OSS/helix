import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { App, RepoBinding } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { AuthProvider } from "../auth/AuthProvider";
import { RepositoryTab } from "../pages/tabs/RepositoryTab";
import { setToken, clearToken } from "../auth/tokenStore";

/**
 * The Repository tab (ADR-0051): connect, edit and disconnect the app's GitHub
 * binding, and say whether the first deploy has pinned the repo yet. The server
 * is the real gate (`ownsApp`); the tab renders its 403 rather than a form.
 */

const APP: App = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "cost-explorer",
  displayName: "Cost Explorer",
  visibility: { mode: "internal" },
  currentVersionId: null,
  archivedAt: null,
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
};

const BINDING: RepoBinding = {
  provider: "github",
  repoFullName: "octo-org/octo-app",
  branch: "main",
  repositoryId: "1001",
  repositoryOwnerId: "2002",
  pinnedAt: "2026-10-19T01:00:00.000Z",
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T01:00:00.000Z",
};

type Reply = { status: number; body?: unknown };

/** Routes the tab's requests; `binding` answers GET, `onWrite` records PUT/DELETE. */
function stubApi(binding: Reply, onWrite?: (method: string, body: unknown) => Reply) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply = ({ status, body }: Reply) =>
      Promise.resolve({ ok: status < 400, status, json: async () => body });
    if (url.endsWith("/api/v1/auth/config")) {
      return reply({
        status: 200,
        body: { issuer: "https://idp.test", cliClientId: "c", webClientId: "w" },
      });
    }
    if (url.endsWith("/api/v1/me")) {
      return reply({
        status: 200,
        body: { sub: "a@x", via: "oidc", isAdmin: false, canSearchDirectory: true },
      });
    }
    if (url.endsWith("/repo-binding")) {
      const method = init?.method ?? "GET";
      if (method === "GET") return reply(binding);
      return reply(
        onWrite?.(method, init?.body ? JSON.parse(String(init.body)) : undefined) ?? {
          status: 204,
        },
      );
    }
    return new Promise(() => {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function render() {
  setToken("t");
  renderWithProviders(
    <AuthProvider>
      <RepositoryTab app={APP} />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

const NO_BINDING: Reply = {
  status: 404,
  body: {
    error: {
      code: "not_found",
      message: "this app has no repo binding",
      details: { reason: "no_binding" },
    },
  },
};

describe("RepositoryTab", () => {
  it("offers a connect form for an unbound app and sends the binding", async () => {
    const writes: unknown[] = [];
    stubApi(NO_BINDING, (method, body) => {
      writes.push([method, body]);
      return { status: 200, body: { ...BINDING, repositoryId: undefined } };
    });
    render();
    const user = userEvent.setup();
    const connect = await screen.findByRole("button", { name: "Connect" });
    expect(connect.hasAttribute("disabled")).toBe(true);
    await user.type(screen.getByLabelText("Repository"), "octo-org/octo-app");
    await user.click(connect);
    expect(writes).toEqual([["PUT", { repoFullName: "octo-org/octo-app", branch: "main" }]]);
  });

  it("flags an invalid repository and keeps Connect disabled", async () => {
    stubApi(NO_BINDING);
    render();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Repository"), "not a repo");
    expect(screen.getByText(/owner\/name/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows a pinned binding and warns that changing the repo clears the pin", async () => {
    stubApi({ status: 200, body: BINDING });
    render();
    expect(await screen.findByText("pinned")).toBeDefined();
    expect(screen.getByText(/repository id 1001/)).toBeDefined();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const repo = screen.getByLabelText("Repository");
    await user.clear(repo);
    await user.type(repo, "octo-org/other");
    expect(screen.getByText(/clears the pinned ids/)).toBeDefined();
  });

  it("says when the first deploy hasn't pinned the repo yet", async () => {
    stubApi({
      status: 200,
      body: {
        ...BINDING,
        repositoryId: undefined,
        repositoryOwnerId: undefined,
        pinnedAt: undefined,
      },
    });
    render();
    expect(await screen.findByText("awaiting first deploy")).toBeDefined();
  });

  it("disconnects after confirming", async () => {
    const writes: string[] = [];
    stubApi({ status: 200, body: BINDING }, (method) => {
      writes.push(method);
      return { status: 204 };
    });
    render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Disconnect the repository?")).toBeDefined();
    const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" });
    await user.click(confirm);
    await vi.waitFor(() => expect(writes).toEqual(["DELETE"]));
  });

  it("tells a non-owner the binding is owner-only", async () => {
    stubApi({
      status: 403,
      body: { error: { code: "forbidden", message: "you do not own this app" } },
    });
    render();
    expect(await screen.findByText(/Only the app's owner/)).toBeDefined();
  });
});
