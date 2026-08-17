import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./render";
import { UploadStep } from "../deploy/UploadStep";

/**
 * The regression the dual review caught (ADR-0038 #2): a dropped folder must
 * reach the planner and raise the confirm step. The Mantine dropzone previously
 * carried an `application/zip` accept filter that silently rejected every file a
 * folder expands to, so the headline feature did nothing. Here we drive the same
 * `onDrop` path the dropzone/folder-picker use, with folder files.
 */

const APPS_BASE = "https://apps.example.com";

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/config")
        return Promise.resolve(json({ appPublicBase: APPS_BASE, deployMaxBundleMb: 250 }));
      if (url.endsWith("/manifest"))
        return Promise.resolve(
          json({ app: "demo", visibility: { mode: "internal" }, capabilities: emptyCaps() }),
        );
      return new Promise<Response>(() => {}); // uploads/others: pending
    }),
  );
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function emptyCaps() {
  return { mcp: [], externalOrigins: [] };
}

/** A File carrying a react-dropzone-style `.path`, as a folder drop yields. */
function folderFile(path: string, content: string): File {
  return Object.assign(new File([content], path.split("/").pop() ?? path), { path });
}

afterEach(() => vi.unstubAllGlobals());

describe("UploadStep — folder drop", () => {
  it("takes a dropped project folder to the confirm step, re-rooting to the build dir", async () => {
    stubFetch();
    renderWithProviders(<UploadStep slug="demo" authenticated onDone={() => {}} />);

    // Wait for the manifest to resolve so planning is unblocked (#12), then use
    // the "choose a folder" input, which calls the same handler a drag would.
    const input = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('input[webkitdirectory=""]');
      if (!el || el.disabled) throw new Error("folder input not ready");
      return el;
    });

    // A whole project folder: the build is in dist/, package.json is not served.
    // (A clean build folder would be canonical and upload without a gate; this
    // one re-roots, which is what makes the confirm step appear.)
    const files = [
      folderFile("proj/dist/index.html", "<!doctype html><h1>hi</h1>"),
      folderFile("proj/dist/app.js", "console.log(1)"),
      folderFile("proj/package.json", "{}"),
    ];
    fireEvent.change(input, { target: { files } });

    expect(await screen.findByText(/Will deploy 2 files/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Deploy this/ })).toBeTruthy();
    // The dropped project files that aren't the build are shown as dropped.
    expect(screen.getByText(/outside the build/)).toBeTruthy();
  });
});
