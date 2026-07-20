import { describe, it, expect, vi, beforeEach } from "vitest";

// First DNS mock in the repo: lets us exercise the resolveAndValidate AAAA-rebind
// path (the real SSRF exploit vector) without a live resolver. Hoisted by vitest.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isBlockedAddress, resolveAndValidate, SsrfBlockedError } from "./ssrf.js";

const mockLookup = vi.mocked(lookup);

// resolveAndValidate calls lookup(host, { all: true }), which returns an array;
// vi.mocked resolves to the single-address overload, so cast the array once here.
function resolveTo(addrs: LookupAddress[]): void {
  mockLookup.mockResolvedValue(addrs as unknown as LookupAddress);
}

describe("isBlockedAddress — IPv6 forms now blocked", () => {
  // Every row here returned `false` (treated as public) under the old
  // prefix-matching implementation — the issue #2 bypass table plus edges.
  it.each([
    "fe80::1", // link-local
    "fea0::1", // link-local — the /10 the old `fe80` prefix missed
    "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", // upper edge of fe80::/10
    "fec0::1", // site-local (deprecated)
    "fc00::1", // ULA
    "fd00::1", // ULA
    "fdff:ffff::1", // ULA upper
    "::1", // loopback
    "::", // unspecified
    "::7f00:1", // ::127.0.0.1 (v4-compatible loopback, hex)
    "::ffff:7f00:1", // 127.0.0.1 (v4-mapped, hex — the form URL parsing produces)
    "::ffff:a9fe:a9fe", // 169.254.169.254 (v4-mapped IMDS, hex)
    "64:ff9b::a9fe:a9fe", // NAT64-embedded 169.254.169.254 (IMDS)
    "64:ff9b:1::a9fe:a9fe", // NAT64 local-use /48
    "2002:7f00:1::1", // 6to4-embedded 127.0.0.1
    "2002:a9fe:a9fe::1", // 6to4-embedded 169.254.169.254
    "2001:0:0::1", // Teredo (2001::/23)
    "100::1", // discard-only
    "2001:db8::1", // documentation
    "ff02::1", // multicast
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
});

describe("isBlockedAddress — IPv6 public targets allowed", () => {
  it.each([
    "2606:4700:4700::1111", // Cloudflare DNS
    "2001:4860:4860::8888", // Google DNS
    "2a00:1450:4009:80f::200e", // Google
    "::ffff:8.8.8.8", // public v4-mapped — extraction allows it
    "64:ff9b::8.8.8.8", // NAT64-to-public — extraction allows it
  ])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("isBlockedAddress — zone identifiers", () => {
  it("strips the %zone and still classifies the base scope", () => {
    expect(isBlockedAddress("fe80::1%eth0")).toBe(true);
  });
});

describe("isBlockedAddress — IPv4 ranges (regression)", () => {
  it.each([
    "169.254.169.254", // IMDS
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.0.1",
    "0.0.0.0",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1"])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("IPv4 alternate literals are normalized by the URL parser, not isBlockedAddress", () => {
  // The decimal/hex/octal/short IPv4 forms raised in review never reach
  // isBlockedAddress in raw form: the WHATWG URL parser normalizes them to the
  // dotted quad first. This proves *where* the safety comes from.
  it.each([
    "http://2130706433/", // decimal
    "http://0x7f000001/", // hex
    "http://127.1/", // short form
    "http://0177.0.0.1/", // octal
  ])("URL parser normalizes %s to 127.0.0.1", (url) => {
    const { hostname } = new URL(url);
    expect(hostname).toBe("127.0.0.1");
    expect(isBlockedAddress(hostname)).toBe(true);
  });

  it("defensively refuses an un-normalized bare-integer literal", () => {
    // Not the real defense (the URL layer is) — but a raw string that is neither
    // a dotted quad nor a valid IP literal hits the refuse-unrecognized branch.
    expect(isBlockedAddress("2130706433")).toBe(true);
  });
});

describe("resolveAndValidate — DNS AAAA rebind (mocked lookup)", () => {
  beforeEach(() => mockLookup.mockReset());

  it("rejects a host whose AAAA is NAT64-embedded IMDS", async () => {
    resolveTo([{ address: "64:ff9b::a9fe:a9fe", family: 6 }]);
    await expect(resolveAndValidate("api.partner.com", false)).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects a host whose AAAA is a hex v4-mapped loopback", async () => {
    resolveTo([{ address: "::ffff:7f00:1", family: 6 }]);
    await expect(resolveAndValidate("api.partner.com", false)).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("resolves a genuinely public AAAA", async () => {
    resolveTo([{ address: "2606:4700:4700::1111", family: 6 }]);
    await expect(resolveAndValidate("api.partner.com", false)).resolves.toEqual({
      address: "2606:4700:4700::1111",
      family: 6,
    });
  });

  it("rejects the whole host when any address is blocked (dual-record)", async () => {
    resolveTo([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "::ffff:7f00:1", family: 6 },
    ]);
    await expect(resolveAndValidate("api.partner.com", false)).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("bypasses validation under the allowPrivate dev/test seam", async () => {
    resolveTo([{ address: "64:ff9b::a9fe:a9fe", family: 6 }]);
    await expect(resolveAndValidate("api.partner.com", true)).resolves.toEqual({
      address: "64:ff9b::a9fe:a9fe",
      family: 6,
    });
  });
});

describe("resolveAndValidate — IP-literal branch", () => {
  beforeEach(() => mockLookup.mockReset());

  it("strips brackets and blocks a mapped-loopback literal without a DNS lookup", async () => {
    await expect(resolveAndValidate("[::ffff:7f00:1]", false)).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
