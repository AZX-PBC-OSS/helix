/**
 * The executable signing vectors run against the reference implementation in
 * `./jobsSigning.ts`, plus unit coverage of the engine surfaces the vectors
 * present through data: key derivation, the resource builder, the production
 * mint path, and verify's fail-closed robustness.
 */

import { randomBytes } from "node:crypto";

import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import * as subpathEngine from "@azx-pbc/shared/jobsSigning";
import * as subpathVectors from "@azx-pbc/shared/jobsSigningVectors";
import { JOBS_FETCH_QUALIFIED_TYPE } from "./jobs.js";
import {
  buildJobsInternalResource,
  deriveJobsInstructionKey,
  JobsCancelClaimsSchema,
  JobsFetchCallbackClaimsSchema,
  JobsLifecycleClaimsSchema,
  JobsOperations,
  JobsResultClaimsSchema,
  JobsSigningDomains,
  JobsSnapshotClaimsSchema,
  JobsSubmitClaimsSchema,
  JOBS_EMPTY_BODY,
  JOBS_INSTRUCTION_BURN_RETENTION_SECONDS,
  JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS,
  JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS,
  JOBS_INSTRUCTION_REJECT_REASONS,
  mintJobsInstruction,
  sha256BodyDigest,
  signJobsInstructionClaims,
  verifyJobsInstruction,
  type JobsInstructionMintSpec,
  type JobsInstructionVerifyResult,
} from "./jobsSigning.js";
import {
  implementJobsVectorTransform,
  JOBS_GOLDEN_TOKEN_VECTORS,
  JOBS_SIGNING_VECTORS,
  JOBS_SIGNING_VECTOR_ROOTS,
  runJobsGoldenTokenVectors,
  runJobsSigningVectors,
  type JobsSigningVectorHarness,
  type JobsVectorVerdict,
} from "./jobsSigningVectors.js";

const utf8 = new TextEncoder();
const SERVER = "jobs";
const APP_ID = "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f";
const OWNER_OID = "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d";
const JOB_ID = "w9QZzaBp4XkR3tYm017c3";
const SUBMIT_BODY = '{"url":"https://example.com/data.json"}';

function vectorKey(keyId: string): Uint8Array {
  const entry = JOBS_SIGNING_VECTOR_ROOTS[keyId];
  if (!entry) throw new Error(`no such vector root: ${keyId}`);
  return deriveJobsInstructionKey(entry.root, entry.direction);
}

/** Decode a compact token's header and payload for wire-level assertions. */
function decodeToken(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [headerSegment, payloadSegment] = token.split(".");
  const decode = (segment: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  return { header: decode(headerSegment as string), payload: decode(payloadSegment as string) };
}

const referenceHarness: JobsSigningVectorHarness = {
  async sign({ typ, keyId, claims }) {
    return signJobsInstructionClaims(typ, claims, vectorKey(keyId));
  },
  transform: implementJobsVectorTransform,
  async verify({ token, keyId, expected, nowS }) {
    const verdict: JobsInstructionVerifyResult = await verifyJobsInstruction(
      token,
      vectorKey(keyId),
      expected,
      nowS,
    );
    return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
  },
};

describe("the node-only subpath exports", () => {
  it("resolve to the engine and vector modules — the surface server code imports", () => {
    // These modules stay out of the browser barrel by design; the subpath
    // mapping in package.json is the only way the edge, jobs and portal
    // reach them. A dropped or renamed mapping is a broken consumer import
    // that typecheck alone (source-relative imports in this suite) would not
    // notice.
    expect(subpathEngine.verifyJobsInstruction).toBe(verifyJobsInstruction);
    expect(subpathEngine.JobsOperations).toBe(JobsOperations);
    expect(subpathVectors.JOBS_SIGNING_VECTORS.length).toBe(JOBS_SIGNING_VECTORS.length);
    expect(subpathVectors.runJobsSigningVectors).toBeDefined();
  });
});

describe("runJobsSigningVectors", () => {
  it("the reference implementation passes the whole corpus", async () => {
    await expect(runJobsSigningVectors(referenceHarness)).resolves.toBeUndefined();
  });

  it("carries both acceptances and rejections, and every vector states its reason", () => {
    const accepts = JOBS_SIGNING_VECTORS.filter((v) => v.expect === "accept").length;
    const rejects = JOBS_SIGNING_VECTORS.length - accepts;
    expect(accepts).toBeGreaterThan(0);
    expect(rejects).toBeGreaterThan(0);
    for (const vector of JOBS_SIGNING_VECTORS) {
      expect(vector.why.length > 0, vector.name).toBe(true);
      expect(vector.present.nowS, vector.name).toBeTypeOf("number");
      if (vector.expect !== "accept") {
        expect(JOBS_INSTRUCTION_REJECT_REASONS as readonly string[]).toContain(
          vector.expect.reject,
        );
      }
      for (const keyId of [vector.sign.keyId, vector.present.keyId]) {
        expect(Object.hasOwn(JOBS_SIGNING_VECTOR_ROOTS, keyId), `${vector.name}: ${keyId}`).toBe(
          true,
        );
      }
    }
  });

  it("covers every reject reason the verifier can report", () => {
    // A reason no vector exercises is a reason a receiver could start returning
    // on live traffic without any conformance data noticing.
    const exercised = new Set(
      JOBS_SIGNING_VECTORS.flatMap((v) => (v.expect === "accept" ? [] : [v.expect.reject])),
    );
    for (const reason of JOBS_INSTRUCTION_REJECT_REASONS) {
      expect(exercised.has(reason), reason).toBe(true);
    }
  });

  it("a verifier that accepts everything fails the corpus by name", async () => {
    const broken: JobsSigningVectorHarness = {
      ...referenceHarness,
      verify: async () => ({ ok: true }),
    };
    await expect(runJobsSigningVectors(broken)).rejects.toThrow(/a flipped signature character/);
  });

  it("a verifier that refuses everything fails the corpus by name", async () => {
    const broken: JobsSigningVectorHarness = {
      ...referenceHarness,
      verify: async () => ({ ok: false, reason: "signature" }),
    };
    await expect(runJobsSigningVectors(broken)).rejects.toThrow(
      /a keyed submit instruction verifies/,
    );
  });

  it("a verifier with the right verdict but the wrong reason fails the corpus", async () => {
    // The reason classes are the operator-facing evidence; a receiver that
    // reports "signature" for an expired token has lost the distinction.
    const broken: JobsSigningVectorHarness = {
      ...referenceHarness,
      verify: async ({ token, keyId, expected, nowS }) => {
        const verdict = await verifyJobsInstruction(token, vectorKey(keyId), expected, nowS);
        if (verdict.ok) return { ok: true };
        return { ok: false, reason: "signature" };
      },
    };
    await expect(runJobsSigningVectors(broken)).rejects.toThrow(/expected rejection with reason/);
  });
});

describe("runJobsGoldenTokenVectors", () => {
  it("the reference implementation accepts the recorded bytes for all three directions", async () => {
    // The minted corpus proves self-agreement: a harness that mints and
    // verifies through one implementation accepts any consistently wrong
    // value of the signing-domain constants. The golden tokens are the
    // recorded wire bytes — presenting them to the reference verify pins the
    // HKDF info, the header profile and the claim encoding literally, in both
    // directions (a mirror implementing the same domain registry is accepted;
    // these constants cannot drift away from the recorded derivation unnoticed).
    await expect(
      runJobsGoldenTokenVectors((input) =>
        referenceHarness.verify({
          token: input.token,
          keyId: input.keyId,
          expected: input.expected,
          nowS: input.nowS,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("a verifier that accepts everything fails the golden corpus by name", async () => {
    await expect(runJobsGoldenTokenVectors(async () => ({ ok: true }))).rejects.toThrow(
      /a golden token is refused under another direction's root/,
    );
  });

  it("a verifier that refuses everything fails the golden corpus by name", async () => {
    await expect(
      runJobsGoldenTokenVectors(async () => ({ ok: false, reason: "signature" })),
    ).rejects.toThrow(/the golden edge→jobs submit instruction verifies/);
  });

  it("every golden vector names why, its root is recorded, and all three directions stay covered", () => {
    for (const vector of JOBS_GOLDEN_TOKEN_VECTORS) {
      expect(vector.why.length > 0, vector.name).toBe(true);
      expect(Object.hasOwn(JOBS_SIGNING_VECTOR_ROOTS, vector.keyId), vector.name).toBe(true);
      // A golden token is a compact JWS: three base64url segments.
      expect(vector.token.split("."), vector.name).toHaveLength(3);
    }
    // Direction completeness: the goldens are the wire-side anchor per
    // direction — a recorded anchor that drops out silently degrades that
    // direction's dual-pinning to source-literals only, with no other signal.
    // The minted corpus's meta-tests pin its two-sidedness; this is the
    // golden corpus's equivalent.
    const covered = new Set(
      JOBS_GOLDEN_TOKEN_VECTORS.flatMap((vector) => {
        const root = JOBS_SIGNING_VECTOR_ROOTS[vector.keyId];
        expect(root, vector.name).toBeDefined();
        return root ? [root.direction] : [];
      }),
    );
    for (const direction of ["edgeToJobs", "jobsToEdge", "portalToJobs"] as const) {
      expect(covered.has(direction), `no golden token covers the ${direction} direction`).toBe(
        true,
      );
    }
  });

  it("a throwing or nothing-resolving verifier is a named failure and the corpus still runs", async () => {
    // The fault contract the minted runner's pins state, holding here too: a
    // mirror's verify that throws — or resolves to a verdict whose shape the
    // judgment cannot read — is the mirror's fault, named for the vector,
    // with the corpus continuing. The fault lands on the first golden vector
    // and a later vector's verdict is also wrong, so the report must carry
    // both — which an aborted run (a bare exception at the fault) could
    // never produce.
    for (const fault of ["throw", "null"] as const) {
      let calls = 0;
      let message = "";
      try {
        await runJobsGoldenTokenVectors(async () => {
          calls += 1;
          if (calls === 1) {
            if (fault === "throw") throw new Error("mirror golden verify exploded");
            return null as unknown as JobsVectorVerdict;
          }
          if (calls === 2) return { ok: false, reason: "audience" };
          return { ok: true };
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, `a ${fault} fault`).toContain("jobs golden-token vectors failed");
      expect(message, `the fault must be named for the first vector (${fault})`).toContain(
        'vector "the golden edge→jobs submit instruction verifies": the harness could not verify',
      );
      expect(
        message,
        `the corpus must run past the fault — a later vector's mismatch is in the same report (${fault})`,
      ).toContain('vector "the golden fetch callback instruction verifies" expected acceptance');
    }
  });
});

describe("the signing-domain constants are stated once as literals", () => {
  // The registry is derived-from nowhere: these strings ARE the contract, and
  // the golden tokens pin them from the wire side. The literals here pin them
  // from the source side — a value that drifts fails one or the other, and a
  // deliberate change must edit both, in the open.
  it("carries the exact strings for all three directions", () => {
    expect(JobsSigningDomains.edgeToJobs).toEqual({
      secretEnvVar: "JOBS_EDGE_TO_JOBS_SECRET",
      jwtTyp: "helix-edge-jobs+jwt",
      audiencePrefix: "helix-jobs:",
      hkdfInfo: "helix-edge-jobs-v1",
      issuer: "helix-edge",
    });
    expect(JobsSigningDomains.jobsToEdge).toEqual({
      secretEnvVar: "JOBS_JOBS_TO_EDGE_SECRET",
      jwtTyp: "helix-jobs-edge+jwt",
      audiencePrefix: "helix-edge-jobs-callback:",
      hkdfInfo: "helix-jobs-edge-v1",
      issuerPrefix: "helix-jobs:",
    });
    expect(JobsSigningDomains.portalToJobs).toEqual({
      secretEnvVar: "JOBS_PORTAL_TO_JOBS_SECRET",
      jwtTyp: "helix-portal-jobs+jwt",
      audiencePrefix: "helix-jobs-lifecycle:",
      hkdfInfo: "helix-portal-jobs-v1",
      issuer: "helix-portal",
    });
  });
});

describe("deriveJobsInstructionKey", () => {
  const EDGE_JOBS_ROOT = JOBS_SIGNING_VECTOR_ROOTS["edge-to-jobs.jobs"];
  if (!EDGE_JOBS_ROOT) throw new Error("the edge-to-jobs.jobs vector root is missing");
  const ROOT = EDGE_JOBS_ROOT.root;

  it("derives 32 bytes deterministically", () => {
    const first = deriveJobsInstructionKey(ROOT, "edgeToJobs");
    const second = deriveJobsInstructionKey(ROOT, "edgeToJobs");
    expect(first).toHaveLength(32);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it("domain-separates the directions — one root never yields another direction's key", () => {
    const keys = (["edgeToJobs", "jobsToEdge", "portalToJobs"] as const).map((direction) =>
      Buffer.from(deriveJobsInstructionKey(ROOT, direction)).toString("hex"),
    );
    expect(new Set(keys).size).toBe(3);
  });

  it("refuses a root that is not the canonical base64 of 32 bytes", () => {
    for (const bad of [
      "",
      "not base64!!",
      Buffer.from(randomBytes(31)).toString("base64"),
      Buffer.from(randomBytes(33)).toString("base64"),
      // base64url is a different alphabet — the root encoding is standard base64.
      Buffer.from(randomBytes(32)).toString("base64url"),
      // canonical text, but whitespace breaks the canonical round-trip
      `${ROOT.slice(0, 10)} ${ROOT.slice(11)}`,
    ]) {
      expect(() => deriveJobsInstructionKey(bad, "edgeToJobs"), bad).toThrow(
        /base64-encoded 32-byte root/,
      );
    }
  });
});

describe("buildJobsInternalResource", () => {
  it("builds each operation's resource from its parameters", () => {
    expect(buildJobsInternalResource("submit")).toBe("/internal/jobs/v1/jobs");
    expect(buildJobsInternalResource("snapshot", { jobId: JOB_ID })).toBe(
      `/internal/jobs/v1/jobs/${JOB_ID}`,
    );
    expect(buildJobsInternalResource("result", { jobId: JOB_ID })).toBe(
      `/internal/jobs/v1/jobs/${JOB_ID}/result`,
    );
    expect(buildJobsInternalResource("cancel", { jobId: JOB_ID })).toBe(
      `/internal/jobs/v1/jobs/${JOB_ID}`,
    );
    expect(buildJobsInternalResource("fetch")).toBe("/internal/jobs/v1/fetch");
    expect(buildJobsInternalResource("lifecycle", { appId: APP_ID })).toBe(
      `/internal/jobs/v1/lifecycle/${APP_ID}`,
    );
  });

  it("refuses to build a parameterized resource without a valid parameter", () => {
    expect(() => buildJobsInternalResource("snapshot")).toThrow(/binds a job id/);
    expect(() => buildJobsInternalResource("snapshot", { jobId: "abc/123" })).toThrow(
      /binds a job id/,
    );
    expect(() => buildJobsInternalResource("lifecycle", { appId: "not-a-uuid" })).toThrow(
      /binds an app id/,
    );
  });
});

describe("mintJobsInstruction", () => {
  const USER_IDENTITY = {
    appId: APP_ID,
    env: "prod",
    ownerKind: "user",
    ownerOid: OWNER_OID,
    allowedTypes: ["jobs:fetch"],
  } as const;
  const CALLBACK_IDENTITY = {
    appId: APP_ID,
    env: "prod",
    ownerKind: "user",
    ownerOid: OWNER_OID,
    type: JOBS_FETCH_QUALIFIED_TYPE,
  } as const;
  const KEY = vectorKey("edge-to-jobs.jobs");

  function expectVerdict(
    verdict: JobsInstructionVerifyResult,
  ): asserts verdict is Extract<JobsInstructionVerifyResult, { ok: true }> {
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
  }

  it.each([
    {
      operation: "submit",
      spec: {
        operation: "submit",
        server: SERVER,
        identity: USER_IDENTITY,
        type: JOBS_FETCH_QUALIFIED_TYPE,
        generation: "7",
        idempotencyKey: "retry-key-1",
        body: utf8.encode(SUBMIT_BODY),
        iatS: 1_800_000_000,
      },
      expected: {
        server: SERVER,
        operation: "submit",
        method: JobsOperations.submit.method,
        resource: buildJobsInternalResource("submit"),
        body: utf8.encode(SUBMIT_BODY),
        idempotencyKeyHeader: "retry-key-1",
      },
    },
    {
      operation: "snapshot",
      spec: {
        operation: "snapshot",
        server: SERVER,
        identity: USER_IDENTITY,
        jobId: JOB_ID,
        iatS: 1_800_000_000,
      },
      expected: {
        server: SERVER,
        operation: "snapshot",
        method: JobsOperations.snapshot.method,
        resource: buildJobsInternalResource("snapshot", { jobId: JOB_ID }),
        body: JOBS_EMPTY_BODY,
      },
    },
    {
      operation: "result",
      spec: {
        operation: "result",
        server: SERVER,
        identity: USER_IDENTITY,
        jobId: JOB_ID,
        iatS: 1_800_000_000,
      },
      expected: {
        server: SERVER,
        operation: "result",
        method: JobsOperations.result.method,
        resource: buildJobsInternalResource("result", { jobId: JOB_ID }),
        body: JOBS_EMPTY_BODY,
      },
    },
    {
      operation: "cancel",
      spec: {
        operation: "cancel",
        server: SERVER,
        identity: USER_IDENTITY,
        jobId: JOB_ID,
        iatS: 1_800_000_000,
      },
      expected: {
        server: SERVER,
        operation: "cancel",
        method: JobsOperations.cancel.method,
        resource: buildJobsInternalResource("cancel", { jobId: JOB_ID }),
        body: JOBS_EMPTY_BODY,
      },
    },
    {
      operation: "fetch",
      spec: {
        operation: "fetch",
        server: SERVER,
        identity: CALLBACK_IDENTITY,
        jobId: JOB_ID,
        generation: "7",
        body: utf8.encode(SUBMIT_BODY),
        iatS: 1_800_000_000,
      },
      expected: {
        server: SERVER,
        operation: "fetch",
        method: JobsOperations.fetch.method,
        resource: buildJobsInternalResource("fetch"),
        body: utf8.encode(SUBMIT_BODY),
      },
    },
    {
      operation: "lifecycle",
      spec: {
        operation: "lifecycle",
        server: SERVER,
        appId: APP_ID,
        body: utf8.encode('{"generation":"8","archived":true}'),
        iatS: 1_800_000_000,
      },
      expected: {
        server: SERVER,
        operation: "lifecycle",
        method: JobsOperations.lifecycle.method,
        resource: buildJobsInternalResource("lifecycle", { appId: APP_ID }),
        body: utf8.encode('{"generation":"8","archived":true}'),
      },
    },
  ] as readonly {
    operation: string;
    spec: JobsInstructionMintSpec;
    expected: Parameters<typeof verifyJobsInstruction>[2];
  }[])(
    "mints a $operation instruction its own verifier accepts with the signed claims",
    async ({ spec, expected }) => {
      const key = spec.operation === "fetch" ? vectorKey("jobs-to-edge.jobs") : KEY;
      const token = await mintJobsInstruction(spec, key);
      const verdict = await verifyJobsInstruction(token, key, expected, spec.iatS);
      expectVerdict(verdict);
      if (verdict.ok) {
        expect(verdict.claims.operation).toBe(spec.operation);
        expect(verdict.claims.server).toBe(SERVER);
        if (verdict.claims.operation === "submit") {
          expect(verdict.claims.type).toBe(JOBS_FETCH_QUALIFIED_TYPE);
          expect(verdict.claims.idempotencyKey).toBe("retry-key-1");
        }
        if (verdict.claims.operation === "fetch") {
          expect(verdict.claims.jobId).toBe(JOB_ID);
          expect(verdict.claims.generation).toBe("7");
        }
      }
    },
  );

  it("bodyless operations bind the empty digest even though the spec has no body", async () => {
    const token = await mintJobsInstruction(
      {
        operation: "snapshot",
        server: SERVER,
        identity: USER_IDENTITY,
        jobId: JOB_ID,
        iatS: 1_800_000_000,
      },
      KEY,
    );
    const { payload } = decodeToken(token);
    expect(payload.bodySha256).toBe(sha256BodyDigest(JOBS_EMPTY_BODY));
  });

  it("mints at the platform maximum lifetime with a fresh jti per instruction", async () => {
    const spec: JobsInstructionMintSpec = {
      operation: "submit",
      server: SERVER,
      identity: USER_IDENTITY,
      type: JOBS_FETCH_QUALIFIED_TYPE,
      generation: "7",
      idempotencyKey: null,
      body: utf8.encode(SUBMIT_BODY),
      iatS: 1_800_000_000,
    };
    const first = decodeToken(await mintJobsInstruction(spec, KEY));
    const second = decodeToken(await mintJobsInstruction(spec, KEY));
    for (const { payload } of [first, second]) {
      expect(payload.exp).toBe((payload.iat as number) + JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS);
      expect(payload.iss).toBe("helix-edge");
      expect(payload.aud).toBe("helix-jobs:jobs");
    }
    expect(first.payload.jti).not.toBe(second.payload.jti);
  });

  it("stamps each direction's issuer and audience literally — the server-scoped forms included", async () => {
    // The edge→jobs stamps are pinned by the lifetime test above; the two
    // directions whose issuers are not the bare plane name get their own
    // literal pins, so a drifted issuer/audience template fails here before
    // any receiver sees it.
    const body = utf8.encode(SUBMIT_BODY);
    const iatS = 1_800_000_000;
    const fetchToken = await mintJobsInstruction(
      {
        operation: "fetch",
        server: SERVER,
        identity: CALLBACK_IDENTITY,
        jobId: JOB_ID,
        generation: "7",
        body,
        iatS,
      },
      vectorKey("jobs-to-edge.jobs"),
    );
    const lifecycleToken = await mintJobsInstruction(
      {
        operation: "lifecycle",
        server: SERVER,
        appId: APP_ID,
        body,
        iatS,
      },
      vectorKey("portal-to-jobs.jobs"),
    );
    const fetchPayload = decodeToken(fetchToken).payload;
    expect(fetchPayload.iss).toBe("helix-jobs:jobs");
    expect(fetchPayload.aud).toBe("helix-edge-jobs-callback:jobs");
    const lifecyclePayload = decodeToken(lifecycleToken).payload;
    expect(lifecyclePayload.iss).toBe("helix-portal");
    expect(lifecyclePayload.aud).toBe("helix-jobs-lifecycle:jobs");
  });

  it("stamps the direction's typ and only the profile's header fields", async () => {
    const token = await mintJobsInstruction(
      {
        operation: "lifecycle",
        server: SERVER,
        appId: APP_ID,
        body: utf8.encode('{"generation":"8","archived":true}'),
        iatS: 1_800_000_000,
      },
      vectorKey("portal-to-jobs.jobs"),
    );
    const { header } = decodeToken(token);
    expect(header).toEqual({ alg: "HS256", typ: JobsSigningDomains.portalToJobs.jwtTyp });
  });

  it("refuses to mint a spec that violates the claim contract", async () => {
    const body = utf8.encode(SUBMIT_BODY);
    const iatS = 1_800_000_000;
    const specs: JobsInstructionMintSpec[] = [
      // a type prefixed for another server
      {
        operation: "submit",
        server: SERVER,
        identity: { ...USER_IDENTITY, allowedTypes: ["ml-jobs:fetch"] },
        type: "ml-jobs:fetch",
        generation: "7",
        idempotencyKey: null,
        body,
        iatS,
      },
      // a zero-padded generation
      {
        operation: "submit",
        server: SERVER,
        identity: USER_IDENTITY,
        type: JOBS_FETCH_QUALIFIED_TYPE,
        generation: "007",
        idempotencyKey: null,
        body,
        iatS,
      },
      // an invalid retry key
      {
        operation: "submit",
        server: SERVER,
        identity: USER_IDENTITY,
        type: JOBS_FETCH_QUALIFIED_TYPE,
        generation: "7",
        idempotencyKey: "   ",
        body,
        iatS,
      },
      // a malformed job id parameter
      {
        operation: "snapshot",
        server: SERVER,
        identity: USER_IDENTITY,
        jobId: "abc/123",
        iatS,
      },
      // a malformed app id parameter
      { operation: "lifecycle", server: SERVER, appId: "short", body, iatS },
    ];
    for (const spec of specs) {
      await expect(
        mintJobsInstruction(spec, KEY),
        JSON.stringify(spec.operation),
      ).rejects.toThrow();
    }
  });
});

describe("verifyJobsInstruction robustness", () => {
  const KEY = vectorKey("edge-to-jobs.jobs");
  const expected = {
    server: SERVER,
    operation: "submit",
    method: JobsOperations.submit.method,
    resource: buildJobsInternalResource("submit"),
    body: utf8.encode(SUBMIT_BODY),
    idempotencyKeyHeader: null,
  } as const;
  /** A fully valid submit payload bag, registered claims included. */
  const VALID_SUBMIT_BAG: Record<string, unknown> = {
    iss: "helix-edge",
    aud: "helix-jobs:jobs",
    jti: "robustness-jti",
    iat: 1_800_000_000,
    exp: 1_800_000_030,
    server: SERVER,
    operation: "submit",
    method: JobsOperations.submit.method,
    resource: buildJobsInternalResource("submit"),
    bodySha256: sha256BodyDigest(utf8.encode(SUBMIT_BODY)),
    appId: APP_ID,
    env: "prod",
    ownerKind: "user",
    ownerOid: OWNER_OID,
    allowedTypes: ["jobs:fetch"],
    type: JOBS_FETCH_QUALIFIED_TYPE,
    generation: "7",
    idempotencyKey: null,
  };

  it("returns a verdict, never a throw, for hostile tokens", async () => {
    for (const token of [
      "",
      "not-a-token",
      "a.b",
      "a.b.c.d",
      "...",
      "###.###.###",
      "e30.e30.e30",
      "a".repeat(4096),
    ]) {
      const verdict = await verifyJobsInstruction(token, KEY, expected, 1_800_000_000);
      expect(verdict.ok, token).toBe(false);
    }
  });

  it("fails closed on a token minted over a foreign signing key of the same length", async () => {
    const token = await signJobsInstructionClaims(
      JobsSigningDomains.edgeToJobs.jwtTyp,
      {
        iss: "helix-edge",
        aud: "helix-jobs:jobs",
        jti: "jti",
        iat: 1_800_000_000,
        exp: 1_800_000_030,
        server: SERVER,
        operation: "submit",
        method: "POST",
        resource: buildJobsInternalResource("submit"),
        bodySha256: sha256BodyDigest(utf8.encode(SUBMIT_BODY)),
        appId: APP_ID,
        env: "prod",
        ownerKind: "user",
        ownerOid: OWNER_OID,
        allowedTypes: ["jobs:fetch"],
        type: JOBS_FETCH_QUALIFIED_TYPE,
        generation: "7",
        idempotencyKey: null,
      },
      deriveJobsInstructionKey(Buffer.from(randomBytes(32)).toString("base64"), "edgeToJobs"),
    );
    expect(await verifyJobsInstruction(token, KEY, expected, 1_800_000_000)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("exposes the identity claims the receiver needs, and never the registered ones it handles itself", async () => {
    const token = await mintJobsInstruction(
      {
        operation: "submit",
        server: SERVER,
        identity: {
          appId: APP_ID,
          env: "prod",
          ownerKind: "user",
          ownerOid: OWNER_OID,
          allowedTypes: ["jobs:fetch"],
        },
        type: JOBS_FETCH_QUALIFIED_TYPE,
        generation: "7",
        idempotencyKey: "retry-key-1",
        body: utf8.encode(SUBMIT_BODY),
        iatS: 1_800_000_000,
      },
      KEY,
    );
    const verdict = await verifyJobsInstruction(
      token,
      KEY,
      {
        ...expected,
        idempotencyKeyHeader: "retry-key-1",
      },
      1_800_000_000,
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.claims).toEqual({
        server: SERVER,
        operation: "submit",
        method: "POST",
        resource: buildJobsInternalResource("submit"),
        bodySha256: sha256BodyDigest(utf8.encode(SUBMIT_BODY)),
        appId: APP_ID,
        env: "prod",
        ownerKind: "user",
        ownerOid: OWNER_OID,
        allowedTypes: ["jobs:fetch"],
        type: JOBS_FETCH_QUALIFIED_TYPE,
        generation: "7",
        idempotencyKey: "retry-key-1",
      });
    }
  });

  it("refuses a protected header carrying any field beyond the profile's two", async () => {
    // The profile is exactly {alg, typ}. A header rebuilt with an extra field
    // — kid, jwk, crit — must fail the profile even on a valid signature: a
    // receiver that only compared typ would let attacker-controlled key hints
    // ride on instructions. The corpus cannot express this family (its sign
    // spec only overrides typ), so it is pinned here.
    const token = await new SignJWT(VALID_SUBMIT_BAG)
      .setProtectedHeader({
        alg: "HS256",
        typ: JobsSigningDomains.edgeToJobs.jwtTyp,
        kid: "attacker-controlled",
      })
      .sign(KEY);
    expect(await verifyJobsInstruction(token, KEY, expected, 1_800_000_000)).toEqual({
      ok: false,
      reason: "token_type",
    });
  });

  it("refuses a token whose header claims a different algorithm", async () => {
    // The profile fixes HS256: a token signed under a stronger hash — HS512 —
    // is outside the profile even over the same key. The algorithm allowlist
    // is part of the one cryptographic gate, so the verdict is "signature",
    // not "token_type". The corpus cannot express this family (its sign spec
    // only overrides typ), so it is pinned here.
    const token = await new SignJWT(VALID_SUBMIT_BAG)
      .setProtectedHeader({ alg: "HS512", typ: JobsSigningDomains.edgeToJobs.jwtTyp })
      .sign(KEY);
    expect(await verifyJobsInstruction(token, KEY, expected, 1_800_000_000)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("refuses signed claims carrying an own __proto__ key, however it is spelled", async () => {
    // The claim schemas compose the same raw-key screen the wire bodies use
    // (`strictWireObject` is exported for exactly that pairing), so a claim
    // bag carrying an own __proto__ key — which rest-splitting the registered
    // claims off the decoded payload must not shed — fails the parse the same
    // way a wire body does. Both tokens are validly signed, so the refusal is
    // attributable to the screen and nothing else.
    const bagJson = JSON.stringify(VALID_SUBMIT_BAG);
    for (const key of ["__proto__", "\\u005f_proto__"]) {
      const bag = JSON.parse(`{"${key}":{"polluted":true},${bagJson.slice(1)}`) as Record<
        string,
        unknown
      >;
      expect(Object.getOwnPropertyNames(bag).includes("__proto__")).toBe(true);
      const token = await signJobsInstructionClaims(JobsSigningDomains.edgeToJobs.jwtTyp, bag, KEY);
      expect(await verifyJobsInstruction(token, KEY, expected, 1_800_000_000)).toEqual({
        ok: false,
        reason: "claims",
      });
    }
  });

  it("accepts a jti at the 128-character bound the corpus pins one past", async () => {
    // The vector corpus pins 129 refused; this is the other side of the
    // inclusive bound — the burn key may be exactly 128 characters.
    const token = await signJobsInstructionClaims(
      JobsSigningDomains.edgeToJobs.jwtTyp,
      { ...VALID_SUBMIT_BAG, jti: "j".repeat(128) },
      KEY,
    );
    const verdict = await verifyJobsInstruction(token, KEY, expected, 1_800_000_000);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
  });

  it("applies the clock tolerance as the contract declares it", async () => {
    // Guard on the constants the vectors are written against: the boundary
    // arithmetic (iat − 5 … exp + 5 inclusive) is pinned by the tolerance
    // vectors, and this keeps those numbers honest if the constants move.
    expect(JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS).toBe(5);
    expect(JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS).toBe(30);
  });

  it("the burn-retention floor covers the whole replayable window", () => {
    // The retention constant's documented arithmetic: burned at its first valid
    // presentation, a token can still verify for at most tolerance +
    // maxLifetime + tolerance afterwards, so retention below that accepts
    // replays at the burn stores built on this constant. Raising either bound
    // without raising retention must go red here, not silently at a receiver.
    expect(JOBS_INSTRUCTION_BURN_RETENTION_SECONDS).toBeGreaterThanOrEqual(
      JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS * 2 + JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS,
    );
  });
});

describe("the claim schemas' raw-key screen", () => {
  const USER_IDENTITY = {
    appId: APP_ID,
    env: "prod",
    ownerKind: "user",
    ownerOid: OWNER_OID,
    allowedTypes: ["jobs:fetch"],
  } as const;
  /** Valid claim bags per operation, registered claims already rest-split off. */
  const BASE_BAGS = {
    submit: {
      server: SERVER,
      operation: "submit",
      method: JobsOperations.submit.method,
      resource: buildJobsInternalResource("submit"),
      bodySha256: sha256BodyDigest(utf8.encode(SUBMIT_BODY)),
      ...USER_IDENTITY,
      type: JOBS_FETCH_QUALIFIED_TYPE,
      generation: "7",
      idempotencyKey: null,
    },
    snapshot: {
      server: SERVER,
      operation: "snapshot",
      method: JobsOperations.snapshot.method,
      resource: buildJobsInternalResource("snapshot", { jobId: JOB_ID }),
      bodySha256: sha256BodyDigest(JOBS_EMPTY_BODY),
      ...USER_IDENTITY,
    },
    result: {
      server: SERVER,
      operation: "result",
      method: JobsOperations.result.method,
      resource: buildJobsInternalResource("result", { jobId: JOB_ID }),
      bodySha256: sha256BodyDigest(JOBS_EMPTY_BODY),
      ...USER_IDENTITY,
    },
    cancel: {
      server: SERVER,
      operation: "cancel",
      method: JobsOperations.cancel.method,
      resource: buildJobsInternalResource("cancel", { jobId: JOB_ID }),
      bodySha256: sha256BodyDigest(JOBS_EMPTY_BODY),
      ...USER_IDENTITY,
    },
    fetch: {
      server: SERVER,
      operation: "fetch",
      method: JobsOperations.fetch.method,
      resource: buildJobsInternalResource("fetch"),
      bodySha256: sha256BodyDigest(utf8.encode(SUBMIT_BODY)),
      appId: APP_ID,
      env: "prod",
      ownerKind: "user",
      ownerOid: OWNER_OID,
      type: JOBS_FETCH_QUALIFIED_TYPE,
      jobId: JOB_ID,
      generation: "7",
    },
    lifecycle: {
      server: SERVER,
      operation: "lifecycle",
      method: JobsOperations.lifecycle.method,
      resource: buildJobsInternalResource("lifecycle", { appId: APP_ID }),
      bodySha256: sha256BodyDigest(utf8.encode('{"generation":"8","archived":true}')),
    },
  } as const;
  const CLAIM_SCHEMAS = {
    submit: JobsSubmitClaimsSchema,
    snapshot: JobsSnapshotClaimsSchema,
    result: JobsResultClaimsSchema,
    cancel: JobsCancelClaimsSchema,
    fetch: JobsFetchCallbackClaimsSchema,
    lifecycle: JobsLifecycleClaimsSchema,
  } as const;

  it("every operation's claims refuse an own __proto__ key, however it is spelled", () => {
    // The six schemas are built at four separate construction sites (submit,
    // the job-record factory behind snapshot/result/cancel, the fetch
    // callback, lifecycle), each composing the raw-key screen on its own. A
    // site inlined to a plain z.strictObject sheds the key while the
    // verify-path pin on submit alone stays green, so each schema object is
    // driven here. Each bag is asserted valid first — a refusal from an
    // invalid bag would prove nothing about the screen.
    for (const [operation, schema] of Object.entries(CLAIM_SCHEMAS)) {
      const base = BASE_BAGS[operation as keyof typeof BASE_BAGS];
      expect(schema.safeParse(base).success, operation).toBe(true);
      const bagJson = JSON.stringify(base);
      for (const key of ["__proto__", "\\u005f_proto__"]) {
        const bag = JSON.parse(`{"${key}":{"polluted":true},${bagJson.slice(1)}`) as unknown;
        expect(Object.getOwnPropertyNames(bag).includes("__proto__"), operation).toBe(true);
        expect(schema.safeParse(bag).success, `${operation} / ${key}`).toBe(false);
      }
    }
  });
});

describe("the keyed-submit golden token", () => {
  // Recorded once from the reference implementation over the corpus's public
  // root, with a fixed claim bag and a fixed jti. The corpus's own golden
  // vectors (JOBS_GOLDEN_TOKEN_VECTORS, run by runJobsGoldenTokenVectors in
  // the describe above) are the authoritative recorded-bytes anchor — for the
  // KEYLESS submit, the fetch callback and the lifecycle delivery, plus a
  // cross-direction refusal. This recording is the one variant they do not
  // carry: the submit instruction whose retry identity is a signed key bound
  // to the header, on recorded bytes — the keyed retry binding's only
  // external anchor.
  it("the keyed submit's recorded bytes verify with the signed retry key bound to the header", async () => {
    const token =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6ImhlbGl4LWVkZ2Utam9icytqd3QifQ.eyJpc3MiOiJoZWxpeC1lZGdlIiwiYXVkIjoiaGVsaXgtam9iczpqb2JzIiwianRpIjoiZ29sZGVuLWVkZ2UtdG8tam9icyIsImlhdCI6MTgwMDAwMDAwMCwiZXhwIjoxODAwMDAwMDMwLCJzZXJ2ZXIiOiJqb2JzIiwib3BlcmF0aW9uIjoic3VibWl0IiwibWV0aG9kIjoiUE9TVCIsInJlc291cmNlIjoiL2ludGVybmFsL2pvYnMvdjEvam9icyIsImJvZHlTaGEyNTYiOiJiNmM3YjVkNWM0NjZiNDc2MjM2YjQ1Y2M4NDk0ZTg2YzA5MjllYjZhNGJhYjI4MzNmZTc2NzFhZmM1NzI4MTUxIiwiYXBwSWQiOiIwYjllOGMzZS02ZjJhLTRjOWItOWUxZi0yYTRiNmM4ZDBlMmYiLCJlbnYiOiJwcm9kIiwib3duZXJLaW5kIjoidXNlciIsIm93bmVyT2lkIjoiNGY3YTJiM2MtOWQxZS00YTViLThjNmQtMGUyZjRhNmI4YzBkIiwiYWxsb3dlZFR5cGVzIjpbImpvYnM6ZmV0Y2giXSwidHlwZSI6ImpvYnM6ZmV0Y2giLCJnZW5lcmF0aW9uIjoiNyIsImlkZW1wb3RlbmN5S2V5IjoicmV0cnkta2V5LTEifQ.CNynq-nLWxAjzBaqjlPQZu-0vf3bwEZVUjCTmI3d8J8";
    const verdict = await verifyJobsInstruction(
      token,
      vectorKey("edge-to-jobs.jobs"),
      {
        server: SERVER,
        operation: "submit",
        method: JobsOperations.submit.method,
        resource: buildJobsInternalResource("submit"),
        body: utf8.encode('{"url":"https://example.com/data.json"}'),
        idempotencyKeyHeader: "retry-key-1",
      },
      1_800_000_000,
    );
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    if (verdict.ok && verdict.claims.operation === "submit") {
      expect(verdict.claims.idempotencyKey).toBe("retry-key-1");
    }
  });
});
