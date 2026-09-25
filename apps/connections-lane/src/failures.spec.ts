import { test, expect, openAppAndConnect, waitForResult } from "./lane.js";
import { PopupGate } from "./popupGate.js";
import type { ConnectResult } from "@azx-pbc/shared";

/**
 * The failure-signaling journeys, browser-proven (I-02 T-0031, criteria 25,
 * 28, 29): timeout on an already-expired attempt (arranged through the DB row
 * — the arrange surface — never by waiting wall-clock), the lost completion
 * signaling with the saved connection still usable, and forged success
 * notifications rejected by the helper's receiver rules.
 *
 * The deterministic freeze point is the fixture's VendorFront (the lane-owned
 * TLS terminator the popup's authorize hop rides): holding there freezes the
 * popup AFTER the consult has committed and BEFORE the vendor is asked — which
 * is also the window the popup-gate (CDP Fetch, for the callback hops whose
 * requests are redirect continuations Playwright's route layer never sees)
 * uses to arm itself.
 */

function resultOf(line: string): ConnectResult {
  return JSON.parse(line.slice(line.indexOf(":") + 1)) as ConnectResult;
}

test("timeout — completion at/after expiry cannot establish a connection, and the app's wait ends legibly (criterion 25)", async ({
  page,
  fx,
  world,
  net,
}) => {
  // Freeze the popup at the vendor front: the consult has committed its
  // attempt row, and the browser's authorize navigation is held there — the
  // vendor answered, but the popup cannot move on.
  fx.front.armHold();
  const popup = await openAppAndConnect(page, fx);
  await fx.front.heldRequest();

  // Backdate the attempt's expiry THROUGH THE ARRANGE SURFACE (the row is
  // arrange state; the five-minute prod TTL value is asserted at
  // packages/shared/src/consent.test.ts, in the shared contract's own suite —
  // the lane does not wait wall-clock 5 minutes).
  const attempt = await world.pollUntil(async () => {
    const found =
      (await world.prisma?.connectionConsentAttempt.findFirst({
        where: { providerId: fx.providerId },
      })) ?? null;
    return found;
  }, "the pending consent attempt row");
  await world.prisma!.connectionConsentAttempt.update({
    where: { id: attempt?.id },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });

  // Release: the vendor approves, the callback arrives AT/AFTER expiry, the
  // claim refuses, and the Expired completion page posts the helper's
  // `timeout` outcome — the app's wait ends with no fabricated success.
  fx.front.releaseHold();
  const line = await waitForResult(page, "RESULT:");
  expect(resultOf(line)).toMatchObject({ outcome: "timeout", provider: fx.ref });
  // The popup landed on the Expired completion page — it stays open (only the
  // connected page auto-closes), showing the reason.
  await expect(popup.getByRole("heading", { name: "Expired" })).toBeVisible();

  expect(await world.prisma!.userConnection.count({ where: { providerId: fx.providerId } })).toBe(
    0,
  );
  expect(net.requested("/_api/fetch/")).toHaveLength(0);
});

test("lost completion signaling — the completion response lost in flight: no fabricated success, and the saved connection serves the next call (criterion 29)", async ({
  page,
  fx,
  world,
  net,
}) => {
  // Freeze the popup at the vendor, and arm the popup gate on the callback's
  // RESPONSE stage while the popup cannot move: the freeze is the window that
  // makes the gate's attach deterministic.
  fx.front.armHold();
  const gate = await PopupGate.over(page.context(), "*connections/callback*", "Response");
  const popup = await openAppAndConnect(page, fx);
  await fx.front.heldRequest();
  await gate.attached(2);
  fx.front.releaseHold();

  // Hold the callback's RESPONSE: the real callback ran (the exchange, the
  // CAS save — all committed), but the completion page never reaches the
  // popup. The signaling is lost in flight; the popup never posts.
  const completion = await gate.next();
  expect(completion.url).toContain("/connections/callback");

  // The save is real (the request was processed server-side before its
  // response could be delivered).
  const row = await world.pollUntil(async () => {
    const found = await world.prisma?.userConnection.findFirst({
      where: { userOid: world.userOid, providerId: fx.providerId, env: "prod" },
    });
    return found ?? null;
  }, "the connection row saved before the signaling was lost");
  expect(row?.status).toBe("live");

  // Deliver the completion page WITHOUT its script: the popup renders the
  // success — and the app hears nothing.
  const html = await completion.responseBody();
  await completion.respondModified(
    200,
    "text/html; charset=utf-8",
    html.replace(/<script>[\s\S]*?<\/script>/g, ""),
  );
  await expect(popup.getByRole("heading", { name: "Connected" })).toBeVisible();
  expect(await page.getByTestId("results").textContent()).not.toContain("RESULT:");

  // The user closes the un-closing popup: the helper's wait ends (well inside
  // its five-minute bound) with `cancelled` — never a fabricated success.
  await popup.close();
  const line = await waitForResult(page, "RESULT:");
  expect(resultOf(line).outcome).toBe("cancelled");

  // And the saved connection WORKS: the next explicit call rides it (the
  // criterion-29 property the cancellation leg must not destroy).
  await page.getByTestId("call").click();
  const call = await waitForResult(page, "CALL:");
  expect(call.startsWith("CALL:200:")).toBe(true);
  expect(net.requested("/_api/fetch/")).toHaveLength(1);
  await gate.close();
});

test("forged success from the app's own window is rejected — never reads as successful consent (criterion 28)", async ({
  page,
  fx,
  world,
}) => {
  // Freeze the popup at the vendor while a connect is in flight.
  fx.front.armHold();
  const popup = await openAppAndConnect(page, fx);
  await fx.front.heldRequest();

  // The app posts a PERFECT success message — right source, version, provider,
  // outcome — from the app's own window (what a sibling window or the app
  // itself can produce). The receiver rules discard it: the sender is not the
  // popup this call opened.
  await page.getByTestId("forge").click();
  await expect(page.getByTestId("results")).toHaveText(/FORGED/);
  await expect
    .poll(async () => (await page.getByTestId("results").textContent())?.includes("RESULT:"), {
      timeout: 1_500,
      message: "the forged message must never resolve the helper's promise",
    })
    .toBe(false);

  // The real journey still completes: exactly one outcome, the real one.
  fx.front.releaseHold();
  const line = await waitForResult(page, "RESULT:");
  expect(resultOf(line)).toMatchObject({ outcome: "connected", provider: fx.ref });
  const lines = (await page.getByTestId("results").textContent()) ?? "";
  expect(lines.split("\n").filter((l) => l.startsWith("RESULT:"))).toHaveLength(1);
  await expect.poll(async () => popup.isClosed()).toBe(true);
  expect(await world.prisma!.userConnection.count({ where: { providerId: fx.providerId } })).toBe(
    1,
  );
});

test("forged success from the vendor's page is rejected by the origin rule (criterion 28)", async ({
  page,
  fx,
  world,
}) => {
  // The front answers the popup's authorize navigation ITSELF — a page AT THE
  // VENDOR ORIGIN that posts a perfect success message to the opener, then
  // hands the user a Continue link back to the real (pumped) authorize flow.
  const forged = JSON.stringify({
    source: "helix-connect",
    version: 1,
    provider: fx.ref,
    outcome: "connected",
    reason: null,
  });
  const answered = fx.front.respondNextAuthorize(
    (target) => `<!doctype html><html><body><h1>the vendor's page</h1>
<script>window.opener.postMessage(${forged}, "*");</script>
<a id="go" href="${target}">Continue</a></body></html>`,
  );

  const popup = await openAppAndConnect(page, fx);
  await answered;
  // The forged message was posted — and did not resolve the helper.
  await expect
    .poll(async () => (await page.getByTestId("results").textContent())?.includes("RESULT:"), {
      timeout: 1_500,
      message: "the vendor's forged message must never read as consent",
    })
    .toBe(false);

  // Resume the real flow: the real completion is the only outcome.
  await popup.click("#go");
  const line = await waitForResult(page, "RESULT:");
  expect(resultOf(line)).toMatchObject({ outcome: "connected", provider: fx.ref });
  expect(await world.prisma!.userConnection.count({ where: { providerId: fx.providerId } })).toBe(
    1,
  );
});
