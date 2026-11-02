import { describe, expect, it } from "vitest";

import { assertStackHostnamesResolveToLoopback } from "./test/realStack.js";

/**
 * The real-stack harness's hostname preflight, as a unit test. Importing
 * realStack.ts defines functions and constants only — nothing boots at module
 * load — which is what lets this file probe the preflight without starting
 * services.
 */

describe("the real-stack hostname preflight", () => {
  it("accepts this host: public DNS answers 127.0.0.1 for the stack hostnames", async () => {
    await expect(
      assertStackHostnamesResolveToLoopback("local.helix.azxlabs.io"),
    ).resolves.toBeUndefined();
  });

  it("rejects an unresolvable domain, naming the host and the fix", async () => {
    const error = await assertStackHostnamesResolveToLoopback("no-such-stack.invalid").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, "the preflight resolved no-such-stack.invalid — it must not").toBeInstanceOf(
      Error,
    );
    const message = (error as Error).message;
    expect(message).toContain("no-such-stack.invalid");
    expect(message).toContain("/etc/hosts");
  });

  it("rejects a hostname that resolves somewhere other than loopback, naming the address", async () => {
    // An IP literal resolves to itself without a DNS query, so this case
    // needs no network: the base domain is a routable address.
    await expect(assertStackHostnamesResolveToLoopback("192.0.2.10")).rejects.toThrow(
      /192\.0\.2\.10 does not resolve to loopback \(resolved to 192\.0\.2\.10\)/,
    );
  });
});
