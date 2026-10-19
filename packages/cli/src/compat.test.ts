import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalClient } from "./client.js";
import { isOlderThan, warnIfCliTooOld } from "./compat.js";

afterEach(() => vi.restoreAllMocks());

describe("isOlderThan", () => {
  it.each([
    ["0.4.0", "0.5.0", true],
    ["0.5.0", "0.5.0", false],
    ["0.10.0", "0.9.9", false],
    ["1.0.0", "0.99.0", false],
    ["0.5.0-beta.1", "0.5.1", true],
    // Unparsable on either side never warns.
    ["latest", "9.9.9", false],
    ["0.5.0", "soon", false],
  ])("%s < %s is %s", (version, floor, expected) => {
    expect(isOlderThan(version, floor)).toBe(expected);
  });
});

describe("warnIfCliTooOld", () => {
  function portalSending(body: unknown, status = 200) {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));
    return new PortalClient("http://portal");
  }
  const BASE = { appPublicBase: "https://apps.example.com" };

  it("warns when the CLI is below the portal's floor", async () => {
    const warn = vi.fn();
    await warnIfCliTooOld(portalSending({ ...BASE, cli: { minVersion: "0.6.0" } }), "0.5.0", warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/0\.6\.0 or newer.*npx -y @azx-pbc\/helix-cli@latest/);
  });

  it("is silent at or above the floor", async () => {
    const warn = vi.fn();
    await warnIfCliTooOld(portalSending({ ...BASE, cli: { minVersion: "0.5.0" } }), "0.5.0", warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent when the portal predates the handshake", async () => {
    const warn = vi.fn();
    await warnIfCliTooOld(portalSending(BASE), "0.0.1", warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent for an unstamped dev build", async () => {
    const warn = vi.fn();
    await warnIfCliTooOld(portalSending({ ...BASE, cli: { minVersion: "9.0.0" } }), "latest", warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never throws when the portal can't be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const warn = vi.fn();
    await expect(warnIfCliTooOld(new PortalClient("http://portal"), "0.1.0", warn)).resolves.toBe(
      undefined,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
