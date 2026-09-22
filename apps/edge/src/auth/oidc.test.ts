import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildClientAuth,
  certThumbprintX5t,
  groupsClaimOverflowed,
  identityFromClaims,
  OpenIdConnectClient,
} from "./oidc.js";
import { testAuthConfig } from "../test/config.js";

/**
 * Certificate (private_key_jwt) client auth — the path for Entra tenants whose
 * policy blocks symmetric client secrets. The fixture is a throwaway P-256
 * self-signed cert generated for this test; `X5T` is its known SHA-1 thumbprint
 * (base64url), independently computed at fixture-generation time.
 */
const FIXTURE_X5T = "_xneyk9G9Heq1ow16HnlhZ575dE";
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIBjjCCATWgAwIBAgIUX9+oQ1tJP+ryV74QWXo51b8HHyQwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSaGVsaXgtZWRnZS1maXh0dXJlMB4XDTI2MDYyNDIzNDkxNFoX
DTQ2MDYxOTIzNDkxNFowHTEbMBkGA1UEAwwSaGVsaXgtZWRnZS1maXh0dXJlMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE/UQ9DJMxDIi70t1pKBLdbovwJxWolUYU
s3EIKAPspZynvgjm6IJR02Zm52RBC8oNfVBWSyiMsUeeHyVk9veQrKNTMFEwHQYD
VR0OBBYEFEf93Xz0JtZnrJksFEHRHP5L3+PLMB8GA1UdIwQYMBaAFEf93Xz0JtZn
rJksFEHRHP5L3+PLMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIg
bEpoGbPXAfyOM0uqLaP+hUQC18LiUdieFV6UYgiyVbcCIDNyKN3qwoGbp8wB8Qjl
pH/YhOv+/BCbsY5zrqxgvidm
-----END CERTIFICATE-----`;
const FIXTURE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgK2fiJxNjqNrmfHI7
AYpq50Sgs15W4UsJCTItNL4Wh9+hRANCAAT9RD0MkzEMiLvS3WkoEt1ui/AnFaiV
RhSzcQgoA+ylnKe+COboglHTZmbnZEELyg19UFZLKIyxR54fJWT295Cs
-----END PRIVATE KEY-----`;

describe("certThumbprintX5t", () => {
  it("is the base64url SHA-1 thumbprint of the certificate", () => {
    expect(certThumbprintX5t(FIXTURE_CERT)).toBe(FIXTURE_X5T);
  });
});

describe("buildClientAuth", () => {
  it("passes a shared secret positionally (no ClientAuth)", async () => {
    const args = await buildClientAuth({ kind: "secret", clientSecret: "s3cret" });
    expect(args.secret).toBe("s3cret");
    expect(args.clientAuth).toBeUndefined();
  });

  it("builds a private_key_jwt ClientAuth from a certificate (no secret)", async () => {
    const args = await buildClientAuth({
      kind: "certificate",
      privateKeyPem: FIXTURE_KEY,
      certificatePem: FIXTURE_CERT,
    });
    expect(args.secret).toBeUndefined();
    expect(typeof args.clientAuth).toBe("function");
  });

  it("rejects a malformed certificate", async () => {
    await expect(
      buildClientAuth({
        kind: "certificate",
        privateKeyPem: FIXTURE_KEY,
        certificatePem: "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----",
      }),
    ).rejects.toThrow();
  });
});

/**
 * ADR-0040 decision 10's diagnostic. Log-only — the deny is correct either way,
 * since the claim is absent and `visibilityAllows` fails closed on an empty set —
 * so what is under test is whether the operator is pointed at the right cause.
 */
describe("groupsClaimOverflowed", () => {
  it("fires when the overage covers the configured claim", () => {
    expect(groupsClaimOverflowed({ _claim_names: { groups: "src1" } }, "groups")).toBe(true);
    expect(groupsClaimOverflowed({ _claim_names: { roles: "src1" } }, "roles")).toBe(true);
  });

  /**
   * The misattribution this replaced. A deployment reading `roles` where a user
   * simply has no app-role assignment, with an unrelated `_claim_names` present,
   * was told it had a group-overage problem — sending an operator after Entra's
   * 200-group limit when the fix was one role assignment.
   */
  it("does not fire when the overage covers some other claim", () => {
    expect(groupsClaimOverflowed({ _claim_names: { groups: "src1" } }, "roles")).toBe(false);
  });

  it("does not fire when the claim is present, however it arrived", () => {
    expect(
      groupsClaimOverflowed({ groups: ["a"], _claim_names: { groups: "src1" } }, "groups"),
    ).toBe(false);
    // Present but empty is still present: no groups is not the same as overage.
    expect(groupsClaimOverflowed({ groups: [], _claim_names: { groups: "s" } }, "groups")).toBe(
      false,
    );
  });

  it("does not fire on a missing or malformed _claim_names", () => {
    expect(groupsClaimOverflowed({}, "groups")).toBe(false);
    for (const bad of [null, "src1", 42, []]) {
      expect(groupsClaimOverflowed({ _claim_names: bad }, "groups")).toBe(false);
    }
  });
});

/**
 * Mix-up anchor (bug-class ledger): the discovery document's `issuer` claim must
 * be validated against the URL it was fetched from before anything trusts it —
 * a document that names a different issuer is either a misconfigured IdP or an
 * answer from the wrong host, and token requests minted against it would send
 * authorization codes to a mix-up attacker. openid-client enforces the match
 * (throws "discovered metadata issuer does not match the expected issuer"); this
 * pin holds that the enforcement is actually on the edge's discovery path — a
 * swap of the discovery call or a library downgrade fails here, not in prod.
 */
describe("OpenIdConnectClient discovery — issuer anchor", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      // A well-formed discovery document whose `issuer` names some OTHER host
      // than the one it was served from.
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          issuer: "https://evil.example",
          authorization_endpoint: "https://evil.example/authorize",
          token_endpoint: "https://evil.example/token",
          jwks_uri: "https://evil.example/jwks",
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("refuses to become ready when the discovered issuer does not match the fetch URL", async () => {
    const client = new OpenIdConnectClient(
      testAuthConfig({
        issuerUrl: baseUrl,
        allowInsecureIdp: true, // loopback http fixture
      }),
      "https://auth.local.helix.azxlabs.io:8080/callback",
      { info: () => {}, warn: () => {} },
    );
    await client.start();
    // Discovery failed and scheduled its 5s retry; the client must NOT present
    // itself as ready (auth routes 503 while `!isReady()`).
    expect(client.isReady()).toBe(false);
    client.stop(); // clear the retry timer
  });
});

/**
 * ADR-0048 decision 2 (as amended), the unit half (the login refusal itself
 * is driven end to end against a real issuer in flow.integration.test.ts,
 * using dev-idp's `omitOidClaim`). What is under test here is the claim
 * mapping: the configured principal claim — `oid` by default, whatever the
 * issuer's stable id lives in otherwise — is the canonical principal id,
 * taken from that claim only, trimmed and bounded, with no fallback.
 */
describe("identityFromClaims", () => {
  it("takes the principal id from the oid claim — never the pairwise sub", () => {
    const id = identityFromClaims(
      {
        sub: "pairwise-per-client-sub",
        oid: "6b9f4d31-8e2a-4c07-9b5d-111111111111",
        email: "a@b.dev",
      },
      "groups",
    );
    expect(id?.oid).toBe("6b9f4d31-8e2a-4c07-9b5d-111111111111");
    expect(id?.email).toBe("a@b.dev");
    expect(id?.displayName).toBe("a@b.dev");
  });

  it("reads whatever claim is configured — e.g. a non-Entra issuer's stable sub", () => {
    // The seam: on Keycloak/Okta/dex/Google the stable, client-independent id
    // IS the `sub`, and an `oid` claim never exists.
    const id = identityFromClaims(
      { sub: "stable-across-clients", email: "a@b.dev" },
      "groups",
      "sub",
    );
    expect(id?.oid).toBe("stable-across-clients");
    // …and a custom claim name likewise, ignoring claims this issuer never sends.
    const custom = identityFromClaims(
      { sub: "pairwise", uid: "issuer-user-id", email: "a@b.dev" },
      "groups",
      "uid",
    );
    expect(custom?.oid).toBe("issuer-user-id");
  });

  it("refuses a token with no usable principal claim — absent, empty, or garbage", () => {
    expect(identityFromClaims({ sub: "s", email: "a@b.dev" }, "groups")).toBeNull();
    expect(identityFromClaims({ sub: "s", oid: "" }, "groups")).toBeNull();
    expect(identityFromClaims({ sub: "s", oid: 42 }, "groups")).toBeNull();
    expect(identityFromClaims({ sub: "s", oid: null }, "groups")).toBeNull();
    // Garbage rather than absence — the same fail-closed treatment (review
    // finding 4: the value flows into the RLS partition GUC and the stored
    // sessions row, which want a bounded id).
    expect(identityFromClaims({ sub: "s", oid: "   " }, "groups")).toBeNull();
    expect(identityFromClaims({ sub: "s", oid: "x".repeat(65) }, "groups")).toBeNull();
  });

  it("trims the claim value before using it anywhere", () => {
    const id = identityFromClaims({ sub: "s", oid: "  padded-oid  " }, "groups");
    expect(id?.oid).toBe("padded-oid");
    // The displayName rung gets the trimmed value too — it is the same id.
    const bare = identityFromClaims({ sub: "s", oid: "  bare-oid  " }, "groups");
    expect(bare?.displayName).toBe("bare-oid");
  });

  it("reads groups from the configured claim, tolerating absence and garbage", () => {
    expect(identityFromClaims({ oid: "o", groups: ["g1", "g2"] }, "groups")?.groups).toEqual([
      "g1",
      "g2",
    ]);
    expect(identityFromClaims({ oid: "o", roles: ["admin"] }, "groups")?.groups).toEqual([]);
    expect(identityFromClaims({ oid: "o", groups: "g1" }, "groups")?.groups).toEqual([]);
    expect(identityFromClaims({ oid: "o", groups: ["g1", 7, null] }, "groups")?.groups).toEqual([
      "g1",
    ]);
  });

  it("ends the displayName ladder at the principal id — never the sub", () => {
    // An issuer that sends no name, no email and no preferred_username: the
    // contract is a non-empty displayName, and the principal id (never the
    // pairwise sub) is the final rung.
    const id = identityFromClaims({ sub: "pairwise-sub", oid: "the-oid" }, "groups");
    expect(id?.displayName).toBe("the-oid");
    expect(id?.name).toBeNull();
    expect(id?.email).toBeNull();
  });

  it("keeps the capture ladders: name preferred, email before preferred_username", () => {
    const id = identityFromClaims(
      { oid: "o", name: " Alice ", email: "a@b.dev", preferred_username: "alice" },
      "groups",
    );
    expect(id?.displayName).toBe(" Alice ");
    expect(identityFromClaims({ oid: "o", preferred_username: "alice" }, "groups")?.email).toBe(
      null,
    );
    expect(
      identityFromClaims({ oid: "o", preferred_username: "not-an-address" }, "groups")?.displayName,
    ).toBe("not-an-address");
  });
});
