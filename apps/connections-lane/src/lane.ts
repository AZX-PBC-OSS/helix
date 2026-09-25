import { test as base, expect, type Page, type Request } from "@playwright/test";
import type { RunningDevOAuthVendor } from "@azx-pbc/dev-oauth-vendor";
import { LaneWorld, type LaneFixture } from "./world.js";

/**
 * The lane's fixtures. The world (the real services + the TLS boundary) boots
 * once per worker; every test gets a fresh browser context (Playwright's
 * default `page` fixture), a fresh fixture vendor (per-instance modes), a
 * fresh hosted app + session, and a network log of every request the context
 * makes — the "no automatic replay" observations are network-level (criterion
 * 31/53), so they read this log, not app state.
 */

export interface LaneNet {
  /** Every request the context issued: `METHOD url`. */
  requests: string[];
  requested(substring: string): string[];
}

export interface LaneFixtures {
  /** Worker-scoped: the composed platform (real edge/portal/egress/IdP). */
  workerWorld: LaneWorld;
  world: LaneWorld;
  /** The test's fixture: hosted app + provider + vendor + session. */
  fx: LaneFixture;
  /** Network-level log of every request the test's context issued. */
  net: LaneNet;
  /** The app page (the default tab the lane navigates to the app origin). */
  appPage: Page;
}

export const test = base.extend<Omit<LaneFixtures, "workerWorld">, { workerWorld: LaneWorld }>({
  workerWorld: [
    // Playwright requires the fixture function's first argument to be the
    // destructuring pattern — even when nothing is destructured.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const world = new LaneWorld();
      await world.start();
      await use(world);
      await world.stop();
    },
    { scope: "worker" },
  ],

  world: ({ workerWorld }, use) => use(workerWorld),

  net: async ({ context }, use) => {
    const requests: string[] = [];
    const listener = (req: Request) => {
      requests.push(`${req.method()} ${req.url()}`);
    };
    context.on("request", listener);
    await use({
      requests,
      requested: (substring) => requests.filter((r) => r.includes(substring)),
    });
    context.off("request", listener);
  },

  fx: async ({ world, context }, use) => {
    const vendor = await world.startVendor();
    const fx = await world.seedFixture(randomTag(), { vendor });
    await context.addCookies([
      {
        name: "__Host-session",
        value: fx.sessionCookie,
        // `url` form: host-only (no Domain), path / — and `secure` because
        // the app origin is https; the `__Host-` prefix needs all three.
        url: fx.appOrigin,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    await use(fx);
    await vendor.close();
  },

  appPage: async ({ page }, use) => use(page),
});

function randomTag(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** The app's #results block, read as the lines its script wrote. */
export async function resultsOf(page: Page): Promise<string[]> {
  const text = await page.getByTestId("results").textContent();
  return (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Wait for the app page to have reported a result line matching `prefix`. */
export async function waitForResult(page: Page, prefix: string): Promise<string> {
  await expect
    .poll(
      async () => {
        const lines = await resultsOf(page);
        return lines.find((l) => l.startsWith(prefix)) ?? null;
      },
      { intervals: [50, 100, 250] },
    )
    .not.toBeNull();
  const lines = await resultsOf(page);
  return lines.find((l) => l.startsWith(prefix)) as string;
}

/**
 * Open the hosted app (the real edge serves it with the helper injected under
 * the shim.connect grant), wait until `window.helix.connect` exists, and click
 * the given button, capturing the popup it opens.
 */
export async function openAppAndConnect(
  page: Page,
  fx: LaneFixture,
  buttonTestId = "connect",
): Promise<Page> {
  await page.goto(`${fx.appOrigin}/`);
  await expect(page.getByTestId("ref")).toHaveText(`provider ${fx.ref}`);
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { helix?: { connect?: unknown } }).helix?.connect === "function",
  );
  const popupPromise = page.waitForEvent("popup");
  await page.getByTestId(buttonTestId).click();
  return popupPromise;
}

export { expect };
export type { RunningDevOAuthVendor };
