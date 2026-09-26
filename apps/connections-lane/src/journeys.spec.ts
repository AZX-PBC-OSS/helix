import { test, expect, openAppAndConnect, waitForResult } from "./lane.js";
import type { ConnectResult } from "@azx-pbc/shared";

/**
 * The assembled consent journeys, browser-proven (I-02 T-0031, criteria 25–26,
 * 31, 51–53): a real Chromium opens a hosted app the REAL edge serves, selects
 * Connect, and the popup travels start route → consult → fixture vendor →
 * callback through the reverse proxy → egress exchange + seal → connection row
 * → completion message → the app's own retry — the architecture.md §Assembly
 * list, end to end, with the delegated call observed at the fixture's API
 * destination in both configured placements.
 */

function resultOf(line: string): ConnectResult {
  return JSON.parse(line.slice(line.indexOf(":") + 1)) as ConnectResult;
}

/** A CALL line's halves ("CALL:200:{…}" — the body may itself contain colons). */
function callOf(line: string): { status: string; body: string } {
  const rest = line.slice("CALL:".length);
  const at = rest.indexOf(":");
  return { status: rest.slice(0, at), body: rest.slice(at + 1) };
}

test("explicit successful consent — the full journey, Bearer placement (criteria 52–53)", async ({
  page,
  fx,
  world,
  net,
}) => {
  const popup = await openAppAndConnect(page, fx);

  // The app's wait ends with the real completion message — outcome connected,
  // provider named, the attempt tag carried back (the message contract,
  // relayed by the helper).
  const line = await waitForResult(page, "RESULT:");
  const result = resultOf(line);
  expect(result.outcome).toBe("connected");
  expect(result.provider).toBe(fx.ref);
  expect(result.attempt).toMatch(/^[0-9a-f]{32}$/);

  // The completion page closed itself (criterion 30: notify, then close).
  await expect.poll(async () => popup.isClosed(), { intervals: [50, 100] }).toBe(true);

  // The saved row is the journey's own output (never seeded): live, scoped,
  // with the scopes the fixture granted.
  const row = await world.pollUntil(async () => {
    const found = await world.prisma?.userConnection.findFirst({
      where: { userOid: world.userOid, providerId: fx.providerId, env: "prod" },
    });
    return found ?? null;
  }, "the connection row the journey saved");
  expect(row?.status).toBe("live");
  expect(row?.grantedScopes).toEqual(["read", "write"]);
  const material = await world.openMaterial(row?.material as string);

  // The app's OWN retry (criterion 31): one explicit click, one delegated call
  // through edge → egress → the fixture's API destination, token in the
  // configured placement. Nothing replayed it — the log has exactly one call.
  await page.getByTestId("call").click();
  const call = callOf(await waitForResult(page, "CALL:"));
  expect(call.status).toBe("200");
  const echo = JSON.parse(call.body) as { placement: string; token: string | null };
  expect(echo.placement).toBe("header-bearer");
  expect(echo.token).toBe(material.access);
  expect(net.requested("/_api/fetch/")).toHaveLength(1);

  // Focus remains usable across completion (criterion 51's popup clause): the
  // retry that just succeeded was keyboard-driven after the popup closed.
  await page.getByTestId("call").focus();
  await page.keyboard.press("Enter");
  const again = callOf(await waitForResult(page, "CALL:"));
  expect(again.status).toBe("200");
  expect(net.requested("/_api/fetch/")).toHaveLength(2);
});

test("explicit successful consent — named-header placement reaches the API destination", async ({
  context,
  page,
  world,
}) => {
  // A second fixture with the named placement; the vendor's API destination
  // reports which header the token arrived in.
  const vendor = await world.startVendor();
  const fx = await world.seedFixture("named-header", {
    vendor,
    tokenPlacement: { kind: "header", name: "x-user-token" },
  });
  await context.addCookies([
    {
      name: "__Host-session",
      value: fx.sessionCookie,
      url: fx.appOrigin,
      secure: true,
      sameSite: "Lax",
    },
  ]);

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

  await page.getByTestId("call").click();
  const call = JSON.parse((await waitForResult(page, "CALL:")).slice("CALL:200:".length)) as {
    placement: string;
    headerName: string | null;
    token: string | null;
  };
  expect(call.placement).toBe("header");
  expect(call.headerName).toBe("x-user-token");
  expect(call.token).toBe(await world.openMaterial(row?.material as string).then((m) => m.access));
});

test("blocked opening — the REAL popup blocker returns `blocked` for the gesture's second popup, with no navigation and no retry (criterion 26)", async ({
  page,
  fx,
  world,
  net,
}) => {
  // Deny mode: the FIRST call's popup (which gets the gesture's one popup
  // allowance) completes as denied — the SAME test then distinguishes blocked
  // from denied (criterion 25) with nothing saved.
  fx.vendor.setModes({ authorizeMode: "deny" });

  await openAppAndConnect(page, fx, "connect-twice");
  expect(resultOf(await waitForResult(page, "FIRST:")).outcome).toBe("denied");
  const second = resultOf(await waitForResult(page, "SECOND:"));
  expect(second).toMatchObject({ outcome: "blocked", provider: fx.ref });
  expect(second.attempt).toBeUndefined();

  // No navigation of the app page, and no retry: still the same document; the
  // BLOCKED call made no start navigation at all (only the first call's did),
  // and no fetch happened behind either outcome.
  expect(page.url()).toBe(`${fx.appOrigin}/`);
  expect(net.requested("/_api/connections/")).toHaveLength(1);
  expect(net.requested("/_api/fetch/")).toHaveLength(0);
  expect(await world.prisma!.userConnection.count({ where: { providerId: fx.providerId } })).toBe(
    0,
  );
});

test("denial — distinct outcome, keyboard-completable popup with managed focus (criteria 25, 51)", async ({
  page,
  fx,
  world,
  net,
}) => {
  fx.vendor.setModes({ authorizeMode: "deny" });

  const popup = await openAppAndConnect(page, fx);
  const line = await waitForResult(page, "RESULT:");
  expect(resultOf(line)).toMatchObject({ outcome: "denied", provider: fx.ref });

  // The popup landed on the Declined completion page — focused heading (the
  // page's own focus management), a real Close button, and keyboard completion:
  // Tab to it, Enter closes the popup (criterion 51's popup clause).
  await expect(popup.getByRole("heading", { name: "Declined" })).toBeVisible();
  const focused = await popup.evaluate(() => document.activeElement?.tagName ?? "");
  expect(focused).toBe("H1");
  await popup.keyboard.press("Tab");
  await expect(popup.getByRole("button", { name: "Close" })).toBeFocused();
  // Enter activates the Close button — and the activation closes the popup
  // mid-press, so the press itself may report the closed target: the close IS
  // the expected keyboard exit (criterion 51).
  await popup.keyboard.press("Enter").catch(() => {});
  await expect.poll(async () => popup.isClosed()).toBe(true);

  // Nothing saved, nothing called: the app's wait ended at the outcome, and
  // Helix did not replay anything on its own.
  expect(await world.prisma!.userConnection.count({ where: { providerId: fx.providerId } })).toBe(
    0,
  );
  expect(net.requested("/_api/fetch/")).toHaveLength(0);
});

test("cancellation — closing the popup mid-journey acknowledges the cancel and resolves `cancelled` (criterion 29)", async ({
  page,
  fx,
  world,
  net,
}) => {
  // Freeze the popup at the vendor front — the consult has committed and the
  // browser's authorize navigation is held there — then close the popup: the
  // user closed the window instead of completing. The helper's close-poll sees
  // the closure without a completion message.
  fx.front.armHold();
  const popup = await openAppAndConnect(page, fx);
  await fx.front.heldRequest();

  await popup.close();
  fx.front.releaseHold();

  const line = await waitForResult(page, "RESULT:");
  expect(resultOf(line)).toMatchObject({ outcome: "cancelled", provider: fx.ref });

  // The helper acknowledged the cancellation to the platform (fire-once,
  // best-effort — the route that marks the attempt so a late completion can
  // never claim it).
  await expect.poll(() => net.requested("/_api/connections/attempt/cancel").length > 0).toBe(true);

  expect(await world.prisma!.userConnection.count({ where: { providerId: fx.providerId } })).toBe(
    0,
  );
  expect(net.requested("/_api/fetch/")).toHaveLength(0);
});
