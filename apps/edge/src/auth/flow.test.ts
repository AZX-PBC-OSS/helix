import { describe, expect, it } from "vitest";
import { deriveAuthKeys } from "./secrets.js";
import { mintFlowToken, verifyFlowToken, type FlowState } from "./flow.js";
import { TEST_AUTH_SECRET } from "../test/config.js";

const { flowKey, handoffKey } = deriveAuthKeys(TEST_AUTH_SECRET);

const FLOW: FlowState = {
  state: "state-1",
  nonce: "nonce-1",
  codeVerifier: "verifier-1",
  app: "demo",
  rd: "/page",
  silent: false,
};

describe("flow cookie token", () => {
  it("round-trips the flow state", async () => {
    const token = await mintFlowToken(FLOW, flowKey);
    expect(await verifyFlowToken(token, flowKey)).toEqual(FLOW);
  });

  it("rejects the handoff key (domain separation, the other direction)", async () => {
    const token = await mintFlowToken(FLOW, flowKey);
    expect(await verifyFlowToken(token, handoffKey)).toBeNull();
  });

  it("rejects tampered payloads", async () => {
    const token = await mintFlowToken(FLOW, flowKey);
    const [h, p, s] = token.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
    payload.rd = "//evil.example";
    const forged = [h, Buffer.from(JSON.stringify(payload)).toString("base64url"), s].join(".");
    expect(await verifyFlowToken(forged, flowKey)).toBeNull();
  });

  it("rejects structurally wrong payloads", async () => {
    expect(await verifyFlowToken("junk", flowKey)).toBeNull();
    expect(await verifyFlowToken("", flowKey)).toBeNull();
  });
});
