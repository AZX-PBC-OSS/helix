import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveDeviceFlow,
  decodeJwtPayload,
  startDevIdp,
  TestHttpSession,
  type RunningDevIdp,
} from "@azx-pbc/dev-idp";
import { refreshGrant, runDeviceLogin } from "./deviceFlow.js";

/**
 * The real RFC 8628 dance against the in-process dev IdP: initiate, approve
 * in a "browser" (driven from the log callback, like a user would), poll,
 * land tokens; then renew them with the refresh grant.
 */

let idp: RunningDevIdp;

beforeAll(async () => {
  idp = await startDevIdp();
});

afterAll(async () => {
  await idp.close();
});

describe("device flow against dev-idp", () => {
  it("logs in as alice and refreshes the grant", { timeout: 30_000 }, async () => {
    const lines: string[] = [];
    let approval: Promise<void> | null = null;

    const tokens = await runDeviceLogin({
      issuer: idp.issuer,
      clientId: "azx-cli",
      log: (msg) => {
        lines.push(msg);
        // The moment the verification URL is printed, "the user" approves
        // it in a browser — concurrently with the CLI's polling.
        const url = /^\s+(http\S+)/.exec(msg)?.[1];
        if (url && !approval) {
          approval = approveDeviceFlow(new TestHttpSession(), url, "alice@azx.dev");
        }
      },
    });
    await approval;

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    const claims = decodeJwtPayload(tokens.accessToken);
    expect(claims.aud).toBe("urn:helix:portal");
    expect(claims.email).toBe("alice@azx.dev");
    expect(lines.join("\n")).toMatch(/confirm the code: [A-Z]{4}-[A-Z]{4}/i);

    const renewed = await refreshGrant(idp.issuer, "azx-cli", tokens.refreshToken as string);
    expect(renewed.accessToken).toBeTruthy();
    expect(renewed.accessToken).not.toBe(tokens.accessToken);
    expect(decodeJwtPayload(renewed.accessToken).email).toBe("alice@azx.dev");
  });
});
