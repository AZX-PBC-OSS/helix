import { test, expect, openAppAndConnect, waitForResult } from "./lane.js";
import type { ConnectResult } from "@azx-pbc/shared";

/**
 * The My Connections user path, browser-proven (I-02 T-0031, criterion 43's
 * user-path proof): the connection the app journey created is disconnected
 * through the REAL My Connections page — the built portal SPA, a real OIDC
 * login through the dev IdP, the real confirm dialog — and the next delegated
 * call from the app page answers `connection_required` in the browser.
 */

function resultOf(line: string): ConnectResult {
  return JSON.parse(line.slice(line.indexOf(":") + 1)) as ConnectResult;
}

test("disconnect through the real My Connections page — the next delegated call answers connection_required (criterion 43)", async ({
  page,
  fx,
  world,
  context,
}) => {
  // 1 — the connection exists because the app journey created it (the same
  // browser journey as the success spec; never a seeded row).
  const popup = await openAppAndConnect(page, fx);
  const line = await waitForResult(page, "RESULT:");
  expect(resultOf(line).outcome).toBe("connected");
  await expect.poll(async () => popup.isClosed()).toBe(true);
  const row = await world.pollUntil(async () => {
    const found = await world.prisma?.userConnection.findFirst({
      where: { userOid: world.userOid, providerId: fx.providerId, env: "prod" },
    });
    return found ?? null;
  }, "the connection row the journey saved");
  expect(row?.status).toBe("live");

  // 2 — the REAL My Connections page: the built SPA served by the portal, a
  // real code+PKCE login through the dev IdP. The fixture user's `oid` is the
  // edge session's `oid` — the same principal, two planes (ADR-0048).
  const portal = await context.newPage();
  await portal.goto(`${world.portalOrigin}/connections`);
  await portal.getByRole("button", { name: "Sign in" }).click();
  // The dev IdP's login picker — the deterministic fixture interaction.
  await portal.getByRole("link", { name: /Alice Anders/ }).click();
  // Back through /auth/callback into the app: the card is the journey's (the
  // fixture's display name is unique to it — other tests' connections for the
  // same principal may still be listed).
  await expect(portal.getByRole("heading", { name: "My Connections" })).toBeVisible();
  const card = portal.locator(".mantine-Card-root", { hasText: "Lane Vendor " });
  const thisCard = card.filter({ hasText: fx.ref });
  await expect(thisCard).toBeVisible();
  await expect(thisCard.getByText("Prod")).toBeVisible();

  // 3 — disconnect, with the real confirmation dialog (criterion 43: explains
  // the blast radius, requires confirmation).
  await thisCard.getByRole("button", { name: "Disconnect" }).click();
  const dialog = portal.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/affects every app sharing the connection/i)).toBeVisible();
  await expect(dialog.getByText(/Vendor-side authorization remains/i)).toBeVisible();
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(portal.getByText(/Disconnected — Helix access/i)).toBeVisible();

  // The row really left the live set (the page's announcement is not the
  // proof; the state is).
  await world.pollUntil(async () => {
    const found = await world.prisma?.userConnection.findUnique({ where: { id: row?.id } });
    return found?.status === "invalidated" ? found : null;
  }, "the invalidated connection row");

  // 4 — the next delegated call from the app page answers
  // connection_required in the browser, with the provider metadata an app
  // needs to offer Connect again.
  await page.getByTestId("call").click();
  const call = await waitForResult(page, "CALL:");
  expect(call.startsWith("CALL:403:")).toBe(true);
  const err = JSON.parse(call.slice("CALL:403:".length)) as {
    code: string;
    provider: { ref: string };
  };
  expect(err.code).toBe("connection_required");
  expect(err.provider.ref).toBe(fx.ref);
});
