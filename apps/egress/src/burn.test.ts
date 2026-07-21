import { describe, expect, it } from "vitest";
import { INSTRUCTION_BURN_RETENTION_SECONDS } from "@azx-pbc/shared";
import { InMemoryBurnStore } from "./burn.js";

/**
 * Unit coverage for the in-memory burn (the seam's fast path for tests/dev). The
 * Postgres implementation — the one that actually holds across replicas — is
 * exercised in `burn.integration.test.ts`, and the end-to-end replay refusal in
 * `adversarial.test.ts`.
 */
describe("InMemoryBurnStore", () => {
  it("admits a fresh jti and refuses the same jti a second time", async () => {
    const store = new InMemoryBurnStore();
    expect(await store.burn("jti-1")).toBe(true);
    expect(await store.burn("jti-1")).toBe(false);
    // A distinct jti is unaffected.
    expect(await store.burn("jti-2")).toBe(true);
  });

  it("forgets a jti once its retention window has elapsed", async () => {
    let now = 1_000_000;
    const store = new InMemoryBurnStore(() => now);
    expect(await store.burn("jti")).toBe(true);
    expect(await store.burn("jti")).toBe(false); // still remembered
    now += (INSTRUCTION_BURN_RETENTION_SECONDS + 1) * 1000;
    // Past retention the token can no longer verify, so re-admitting is harmless.
    expect(await store.burn("jti")).toBe(true);
  });

  it("sweep drops only expired entries", async () => {
    let now = 0;
    const store = new InMemoryBurnStore(() => now);
    await store.burn("old");
    now += (INSTRUCTION_BURN_RETENTION_SECONDS + 1) * 1000;
    await store.burn("new");
    await store.sweep();
    // `old` was swept (fresh again); `new` is still burned.
    expect(await store.burn("old")).toBe(true);
    expect(await store.burn("new")).toBe(false);
  });
});
