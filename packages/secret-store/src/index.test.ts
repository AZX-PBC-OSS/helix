import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DevEnvelopeSecretStore,
  KeyVaultSecretStore,
  type SecretStore,
  createSecretStore,
} from "./index.js";

const key = randomBytes(32);

describe("DevEnvelopeSecretStore", () => {
  it("seals and opens a round-trip value", async () => {
    const store = new DevEnvelopeSecretStore({ masterKey: key });
    const material = await store.seal("sk_live_abc123");
    expect(material.startsWith("aesgcm:")).toBe(true);
    expect(material).not.toContain("sk_live_abc123");
    expect(await store.open(material)).toBe("sk_live_abc123");
  });

  it("produces a fresh IV per seal (no deterministic ciphertext)", async () => {
    const store = new DevEnvelopeSecretStore({ masterKey: key });
    expect(await store.seal("x")).not.toBe(await store.seal("x"));
  });

  it("rejects a value sealed under a different key (auth tag)", async () => {
    const a = new DevEnvelopeSecretStore({ masterKey: key });
    const b = new DevEnvelopeSecretStore({ masterKey: randomBytes(32) });
    const material = await a.seal("secret");
    await expect(b.open(material)).rejects.toThrow();
  });

  it("rejects tampered or malformed material", async () => {
    const store = new DevEnvelopeSecretStore({ masterKey: key });
    await expect(store.open("not-a-blob")).rejects.toThrow(/malformed/);
    const m = await store.seal("v");
    const tampered = m.slice(0, -2) + (m.endsWith("00") ? "11" : "00");
    await expect(store.open(tampered)).rejects.toThrow();
  });

  it("destroy is a no-op (ciphertext dies with the row)", async () => {
    const store: SecretStore = new DevEnvelopeSecretStore({ masterKey: key });
    await expect(store.destroy(await store.seal("v"))).resolves.toBeUndefined();
  });

  it("refuses a too-short master key", () => {
    expect(() => new DevEnvelopeSecretStore({ masterKey: randomBytes(16) })).toThrow(/>= 32/);
  });
});

describe("createSecretStore", () => {
  it("returns the dev store with a master key", () => {
    expect(createSecretStore({ devMasterKey: key })).toBeInstanceOf(DevEnvelopeSecretStore);
  });
  it("returns the Key Vault store when a vault URL is given", () => {
    expect(createSecretStore({ keyVaultUrl: "https://v.vault.azure.net" })).toBeInstanceOf(
      KeyVaultSecretStore,
    );
  });
  it("requires a master key when no vault URL is set", () => {
    expect(() => createSecretStore({})).toThrow(/devMasterKey is required/);
  });
});

describe("KeyVaultSecretStore", () => {
  it("is a present-but-unwired seam (throws until M5)", async () => {
    const store: SecretStore = new KeyVaultSecretStore("https://v.vault.azure.net");
    await expect(store.seal("v")).rejects.toThrow(/not wired/);
  });
});
