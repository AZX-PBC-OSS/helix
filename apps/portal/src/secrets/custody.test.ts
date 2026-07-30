import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DevEnvelopeSecretStore, KeyVaultSecretStore } from "@azx-pbc/secret-store";
import { createSecretStoreFromEnv } from "./custody.js";

/**
 * This is the single decision point for which custody backend the **production control
 * plane** seals with. An inversion here would silently seal prod credentials under the dev
 * envelope — no test failing, no log line, and the damage only visible in a breach. Both
 * behaviours the function's own doc comment claims are pinned below.
 *
 * Everything runs against an injected `env`, never `process.env`.
 */

const dir = mkdtempSync(join(tmpdir(), "custody-"));

function kekFile(bytes = 32): string {
  const path = join(dir, `kek-${randomBytes(6).toString("hex")}`);
  writeFileSync(path, randomBytes(bytes).toString("hex"));
  return path;
}

describe("createSecretStoreFromEnv", () => {
  it("returns null when neither backend is configured", () => {
    expect(createSecretStoreFromEnv({})).toBeNull();
  });

  it("uses the dev envelope when only the KEK file is set", () => {
    const store = createSecretStoreFromEnv({ DEV_SECRETS_KEK_FILE: kekFile() });
    expect(store).toBeInstanceOf(DevEnvelopeSecretStore);
  });

  it("uses Key Vault when only the vault URL is set", () => {
    const store = createSecretStoreFromEnv({
      AZURE_KEY_VAULT_URL: "https://helix-prod-kvc.vault.azure.net",
    });
    expect(store).toBeInstanceOf(KeyVaultSecretStore);
  });

  it("prefers Key Vault when BOTH are set — never the weaker backend", () => {
    // The inversion this pins: a prod container that still carries a dev KEK path in its
    // env must not quietly seal real credentials under a host-resident key.
    const store = createSecretStoreFromEnv({
      AZURE_KEY_VAULT_URL: "https://helix-prod-kvc.vault.azure.net",
      DEV_SECRETS_KEK_FILE: kekFile(),
    });
    expect(store).toBeInstanceOf(KeyVaultSecretStore);
    expect(store).not.toBeInstanceOf(DevEnvelopeSecretStore);
  });

  it("throws rather than falling back when the KEK is missing", () => {
    expect(() =>
      createSecretStoreFromEnv({ DEV_SECRETS_KEK_FILE: join(dir, "does-not-exist") }),
    ).toThrow(/not found/);
  });

  it("throws rather than falling back when the KEK is too short", () => {
    expect(() => createSecretStoreFromEnv({ DEV_SECRETS_KEK_FILE: kekFile(8) })).toThrow(/>= 32/);
  });

  it("throws rather than falling back when the vault URL is not https", () => {
    // Configured-but-broken custody must fail, not degrade. The plugin turns this into a
    // 503 on the secret routes; what it must never do is seal under something weaker.
    expect(() =>
      createSecretStoreFromEnv({ AZURE_KEY_VAULT_URL: "http://helix-prod-kvc.vault.azure.net" }),
    ).toThrow(/https/);
  });

  it("still refuses to fall back to a present, valid dev KEK when the vault URL is broken", () => {
    expect(() =>
      createSecretStoreFromEnv({
        AZURE_KEY_VAULT_URL: "http://helix-prod-kvc.vault.azure.net",
        DEV_SECRETS_KEK_FILE: kekFile(),
      }),
    ).toThrow(/https/);
  });
});
