import { describe, expect, it } from "vitest";
import { buildClientAuth, certThumbprintX5t, groupsClaimOverflowed } from "./oidc.js";

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
