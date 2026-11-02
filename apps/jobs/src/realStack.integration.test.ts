import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { HealthStatusSchema } from "@azx-pbc/shared";

import { startJsonOrigin, startRealStack, type RealStack } from "./test/realStack.js";

/**
 * The harness's own smoke proof: the whole platform boots from its normal
 * entry points, every readiness body says so, the real IdP's JWTs are accepted
 * by the real portal, and the controlled JSON origin routes and holds. The
 * journey suites build on this; nothing here fakes a service.
 */

let stack: RealStack;

beforeAll(async () => {
  stack = await startRealStack({ label: "harness-smoke" });
}, 240_000);

afterAll(async () => {
  if (stack) await stack.close();
});

describe("the real-stack harness", () => {
  test(
    "all six services report ready through their real readiness bodies",
    { timeout: 60_000 },
    async () => {
      // The dev IdP has no /health: its discovery document is the readiness body.
      const discovery = await stack.request(
        `http://localhost:${stack.ports.idp}/.well-known/openid-configuration`,
      );
      expect(discovery.status).toBe(200);
      expect((discovery.json() as { issuer?: unknown }).issuer).toEqual(
        `http://localhost:${stack.ports.idp}`,
      );

      const bodies = new Map<string, ReturnType<typeof HealthStatusSchema.parse>>();
      for (const name of ["portal", "egress", "jobs", "edge", "devGateway"] as const) {
        const res = await stack.request(
          name === "devGateway"
            ? stack.devGatewayOrigin + "/health"
            : name === "edge"
              ? `https://${stack.baseDomain}:${stack.ports.edge}/health`
              : `http://localhost:${stack.ports[name]}/health`,
        );
        expect(res.status, `${name} /health status`).toBe(200);
        bodies.set(name, HealthStatusSchema.parse(res.json()));
      }

      expect(bodies.get("jobs")?.status).toBe("ok");
      expect(bodies.get("portal")?.status).toBe("ok");

      const edgeCheck = bodies.get("edge")?.checks?.find((c) => c.name === "jobs_reachability");
      expect(edgeCheck?.status).toBe("ok");

      // The dev-gateway reports jobs_reachability when jobs servers are
      // configured — the composition always configures them, so it must be here.
      const devCheck = bodies
        .get("devGateway")
        ?.checks?.find((c) => c.name === "jobs_reachability");
      expect(devCheck?.status).toBe("ok");
    },
  );

  test("the portal API accepts the dev-token principal and advertises jobs:fetch", async () => {
    const res = await stack.portalAsDevToken().get("/api/v1/capabilities");
    expect(res.status).toBe(200);
    const body = res.json() as { jobs?: { types?: Array<{ id?: string }> } };
    expect(body.jobs?.types?.some((t) => t.id === "jobs:fetch")).toBe(true);
  });

  test("the portal API accepts a real IdP JWT (bob)", async () => {
    const client = await stack.portalAs("bob@azx.dev");
    const res = await client.get("/api/v1/apps");
    expect(res.status).toBe(200);
  });

  test("the controlled JSON origin routes, defaults to 404, and holds", async () => {
    const origin = await startJsonOrigin();
    try {
      origin.respond("/data", { status: 200, json: { hello: "world" } });

      const ok = await fetch(`${origin.origin}/data`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ hello: "world" });

      const unknown = await fetch(`${origin.origin}/never-configured`);
      expect(unknown.status).toBe(404);

      const hold = origin.hold("/slow");
      let released = false;
      const held = fetch(`${origin.origin}/slow`).then(async (r) => {
        released = true;
        return { status: r.status, body: (await r.json()) as unknown };
      });
      await hold.arrived;
      await new Promise((r) => setTimeout(r, 150));
      expect(released, "a held request must not answer before release()").toBe(false);
      hold.release();
      const answered = await held;
      expect(answered.status).toBe(404); // held, released, and never configured
      expect(origin.requests.some((r) => r.path === "/slow")).toBe(true);
    } finally {
      await origin.close();
    }
  });
});
