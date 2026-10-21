/**
 * Adversarial probes of the signed-instruction engine aimed at what the vector
 * corpus cannot express: the corpus mints whole claim bags and, since its
 * clock vector, varies the receiver's clock only through the harness seam —
 * the probes here drive the reference verifier directly with clock values,
 * mint-spec timestamps, payload shapes, and verify-result shapes the corpus's
 * sign spec cannot produce. Each test targets one named way the engine could
 * fail open or break its own documented contract.
 */

import { CompactSign } from "jose";
import { describe, expect, it } from "vitest";

import {
  buildJobsInternalResource,
  deriveJobsInstructionKey,
  JobsSigningDomains,
  JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS,
  mintJobsInstruction,
  sha256BodyDigest,
  signJobsInstructionClaims,
  verifyJobsInstruction,
  type JobsInstructionExpectation,
  type JobsInstructionMintSpec,
  type JobsInstructionVerifyResult,
} from "./jobsSigning.js";
import {
  implementJobsVectorTransform,
  JOBS_SIGNING_VECTOR_ROOTS,
  runJobsSigningVectors,
  type JobsSigningVectorHarness,
  type JobsVectorVerdict,
} from "./jobsSigningVectors.js";

const utf8 = new TextEncoder();
const IAT = 1_800_000_000;
const SERVER = "jobs";
const APP_ID = "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f";
const OWNER_OID = "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d";
const BODY = '{"url":"https://example.com/data.json"}';

// The corpus's public edge→jobs root for `jobs` — fixed test data, never deployed.
const ROOT = "q8DSPdnLJdVMREaGet6xJy3J7YhGflOniK+LgxqOd8E=";
const KEY = deriveJobsInstructionKey(ROOT, "edgeToJobs");

const SUBMIT_BAG: Record<string, unknown> = {
  iss: "helix-edge",
  aud: "helix-jobs:jobs",
  jti: "adversarial-jti",
  iat: IAT,
  exp: IAT + 30,
  server: SERVER,
  operation: "submit",
  method: "POST",
  resource: buildJobsInternalResource("submit"),
  bodySha256: sha256BodyDigest(utf8.encode(BODY)),
  appId: APP_ID,
  env: "prod",
  ownerKind: "user",
  ownerOid: OWNER_OID,
  allowedTypes: ["jobs:fetch"],
  type: "jobs:fetch",
  generation: "7",
  idempotencyKey: null,
};

const SUBMIT_EXPECTATION: JobsInstructionExpectation = {
  server: SERVER,
  operation: "submit",
  method: "POST",
  resource: buildJobsInternalResource("submit"),
  body: utf8.encode(BODY),
  idempotencyKeyHeader: null,
};

/** Sign one raw payload bag under the profile over the edge→jobs vector root. */
async function signBag(bag: Record<string, unknown>): Promise<string> {
  const sign = new CompactSign(utf8.encode(JSON.stringify(bag)));
  sign.setProtectedHeader({ alg: "HS256", typ: JobsSigningDomains.edgeToJobs.jwtTyp });
  return sign.sign(KEY);
}

/** Derive one direction's key from a corpus root, by the corpus's own key id. */
function vectorKeyFor(keyId: string): Uint8Array {
  const entry = JOBS_SIGNING_VECTOR_ROOTS[keyId];
  if (!entry) throw new Error(`no such vector root: ${keyId}`);
  return deriveJobsInstructionKey(entry.root, entry.direction);
}

describe("verifyJobsInstruction freshness gate", () => {
  it("refuses an instruction outside its validity window even when the receiver's clock is NaN", async () => {
    // Both freshness comparisons must deny when they cannot be completed: with
    // `nowS = NaN` every comparison is false, so a clock that answers NaN
    // would silently skip the gate instead of failing closed. The engine
    // integer-checks the token's own timestamps; the receiver's clock gets
    // the same discipline at the gate. With no usable reading the engine
    // cannot place the token in time, so the denial is the conservative
    // verdict — the validity moment treated as passed — for any token,
    // whichever side of its window it would occupy.
    const expired = await signBag({ ...SUBMIT_BAG, iat: IAT - 1000, exp: IAT - 970 });
    const future = await signBag({ ...SUBMIT_BAG, iat: IAT + 1000, exp: IAT + 1030 });
    // Control: the same tokens are refused at a sane clock, with the reason
    // each boundary names.
    expect(await verifyJobsInstruction(expired, KEY, SUBMIT_EXPECTATION, IAT)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await verifyJobsInstruction(future, KEY, SUBMIT_EXPECTATION, IAT)).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
    expect(await verifyJobsInstruction(expired, KEY, SUBMIT_EXPECTATION, Number.NaN)).toEqual({
      ok: false,
      reason: "expired",
    });
    // Correction (decision log, 2026-10-14): this expectation originally
    // mirrored the control's `not_yet_valid`. No honest implementation can
    // derive a token-side reason from a broken clock — the two tokens here are
    // structurally identical (same lifetime, same window width) and differ
    // only in absolute time, for which the engine has no anchor — so the
    // denial names the gate's conservative verdict instead. The guard itself
    // (a NaN clock must deny, never skip) is unchanged and is what this test
    // pins.
    expect(await verifyJobsInstruction(future, KEY, SUBMIT_EXPECTATION, Number.NaN)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses an instruction under any non-finite receiver clock, both infinities included", async () => {
    // The clock guard's class is every non-finite number, not only NaN: the
    // old comparisons happened to deny ±Infinity (they compare false only for
    // NaN), but the guard is what states the verdict — no usable reading
    // denies, whichever side of the window the token would occupy. Pinning
    // both infinities keeps the guard's class whole if it is ever narrowed to
    // a NaN-only check.
    const token = await signBag({ ...SUBMIT_BAG, iat: IAT - 1000, exp: IAT - 970 });
    for (const nowS of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(await verifyJobsInstruction(token, KEY, SUBMIT_EXPECTATION, nowS)).toEqual({
        ok: false,
        reason: "expired",
      });
    }
  });
});

describe("verifyJobsInstruction result", () => {
  it("returns the validated jti the receiver must burn", async () => {
    // The verify docstring's burn contract: "A receiver burns the returned
    // `jti` before any side effect." The replay burn is the one-time-use
    // defense, the strict claim schemas forbid carrying the jti among the job
    // claims, and no other accessor exports it — so the verdict itself must
    // hand over the exact jti it just validated, or the documented burn flow
    // is unimplementable through this engine.
    const spec: JobsInstructionMintSpec = {
      operation: "submit",
      server: SERVER,
      identity: {
        appId: APP_ID,
        env: "prod",
        ownerKind: "user",
        ownerOid: OWNER_OID,
        allowedTypes: ["jobs:fetch"],
      },
      type: "jobs:fetch",
      generation: "7",
      idempotencyKey: null,
      body: utf8.encode(BODY),
      iatS: IAT,
    };
    const token = await mintJobsInstruction(spec, KEY);
    const payloadSegment = token.split(".")[1];
    const payload = JSON.parse(
      Buffer.from(payloadSegment as string, "base64url").toString("utf8"),
    ) as { jti?: unknown };

    const verdict = await verifyJobsInstruction(token, KEY, SUBMIT_EXPECTATION, IAT);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    if (verdict.ok) {
      expect(
        Object.hasOwn(verdict, "jti"),
        `the verify result carries no jti to burn — keys: ${Object.keys(verdict).join(", ")}`,
      ).toBe(true);
      expect(verdict.jti, "the returned jti must be the one the token carried").toBe(payload.jti);
    }
  });
});

describe("mintJobsInstruction timestamp discipline", () => {
  const base: JobsInstructionMintSpec = {
    operation: "submit",
    server: SERVER,
    identity: {
      appId: APP_ID,
      env: "prod",
      ownerKind: "user",
      ownerOid: OWNER_OID,
      allowedTypes: ["jobs:fetch"],
    },
    type: "jobs:fetch",
    generation: "7",
    idempotencyKey: null,
    body: utf8.encode(BODY),
    iatS: IAT,
  };

  it("refuses to mint from an iatS that is not a whole second", async () => {
    // Every spec field that reaches the claims is assert-parsed before
    // signing; `iat`/`exp` are stamped after that assert. A fractional iatS
    // mints a token whose timestamps the verifier always refuses, and a NaN
    // iatS signs literally `"iat":null` — a dead instruction, produced
    // silently by the one component that could have caught it.
    await expect(
      mintJobsInstruction({ ...base, iatS: IAT + 0.5 }, KEY),
      "a fractional iatS must not mint",
    ).rejects.toThrow();
    await expect(
      mintJobsInstruction({ ...base, iatS: Number.NaN }, KEY),
      "a NaN iatS must not mint",
    ).rejects.toThrow();
  });

  it("refuses to mint from an iatS whose stamped exp rounds past the lifetime bound", async () => {
    // The guard's contract is "a timestamp the verifier always refuses throws
    // here" — integrality alone does not deliver it. Above 2**53 the number
    // spacing is 2, so `iatS + JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS` can
    // round one second past the true sum: at iatS = 2**53 - 15 the stamped
    // `exp - iat` is 31, which the lifetime check refuses at EVERY clock,
    // lifetime preceding freshness. The guard must hold its own contract at
    // the precision boundary too.
    await expect(
      mintJobsInstruction({ ...base, iatS: 2 ** 53 - 15 }, KEY),
      "exp rounding to iatS + 31 mints a token no receiver may accept",
    ).rejects.toThrow();
  });

  it("mints at the exact representability boundary the refusal sits one second past", async () => {
    // The refusing side is pinned above; this is the other side of the
    // inclusive bound: at iatS = MAX_SAFE_INTEGER − 30 the stamped exp is
    // exactly representable, so the mint succeeds and the lifetime is the
    // platform maximum — a guard tightened by one second would refuse a
    // representable timestamp here.
    const boundaryIat = Number.MAX_SAFE_INTEGER - JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS;
    const token = await mintJobsInstruction({ ...base, iatS: boundaryIat }, KEY);
    const payloadSegment = token.split(".")[1];
    const payload = JSON.parse(
      Buffer.from(payloadSegment as string, "base64url").toString("utf8"),
    ) as { iat?: number; exp?: number };
    expect(payload.iat).toBe(boundaryIat);
    expect(payload.exp).toBe(Number.MAX_SAFE_INTEGER);
    const verdict = await verifyJobsInstruction(token, KEY, { ...SUBMIT_EXPECTATION }, boundaryIat);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
  });

  it("refuses the first iatS past the representability boundary", async () => {
    // One second past the accepting bound, the stamped exp is 2**53 itself —
    // exactly representable, and `exp - iat` computes to exactly 30, so the
    // token would be live: the refusal here is the guard's deliberate
    // one-second conservatism (the subtraction form of the bound, exact
    // without reasoning about the boundary), not dead-token prevention. This
    // is the exact edge between the two tests: a guard off by one either
    // direction fails one of them.
    await expect(
      mintJobsInstruction(
        {
          ...base,
          iatS: Number.MAX_SAFE_INTEGER - JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS + 1,
        },
        KEY,
      ),
      "the first iatS past the guard's bound must not mint",
    ).rejects.toThrow();
  });
});

describe("signed-but-wrong-shape payloads", () => {
  // The corpus's sign spec only overrides `typ` over whole claim bags, so
  // these families — a signature that verifies over a payload the profile
  // never sanctioned — are pinned here against the reference verifier.
  it("refuses an aud array containing the exact audience", async () => {
    // RFC 7519 permits array audiences; this contract pins the exact
    // server-scoped string, so even a well-signed array form is refused.
    const token = await signBag({ ...SUBMIT_BAG, aud: ["helix-jobs:jobs"] });
    expect(await verifyJobsInstruction(token, KEY, SUBMIT_EXPECTATION, IAT)).toEqual({
      ok: false,
      reason: "audience",
    });
  });

  it("refuses a token with no aud at all", async () => {
    // The corpus pins a missing issuer; the audience gets the same refusal —
    // absence is not a match, never a default.
    const { aud, ...bag } = SUBMIT_BAG;
    expect(aud).toBeDefined();
    const token = await signBag(bag);
    expect(await verifyJobsInstruction(token, KEY, SUBMIT_EXPECTATION, IAT)).toEqual({
      ok: false,
      reason: "audience",
    });
  });

  it("refuses a validly signed payload that is not a JSON object", async () => {
    // A scalar or array payload under a valid MAC is not an instruction — the
    // claim parse must refuse it, never coerce or unwrap it.
    for (const payload of [JSON.stringify(5), JSON.stringify([SUBMIT_BAG])]) {
      const sign = new CompactSign(utf8.encode(payload));
      sign.setProtectedHeader({ alg: "HS256", typ: JobsSigningDomains.edgeToJobs.jwtTyp });
      const token = await sign.sign(KEY);
      expect(await verifyJobsInstruction(token, KEY, SUBMIT_EXPECTATION, IAT)).toEqual({
        ok: false,
        reason: "claims",
      });
    }
  });
});

describe("runJobsSigningVectors harness faults", () => {
  it("reports a throwing harness callback as a named vector failure", async () => {
    // The sign path collects a harness fault as a named vector failure and
    // keeps running; `transform` and `verify` are the same kind of harness
    // callback, and the runner's contract is that its failures carry the
    // vector evidence ("the runner throws naming each mismatch"). A mirror
    // whose callback crashes must meet the same report — the bare exception
    // names no vector and strands the rest of the corpus unexecuted. Both
    // post-sign callbacks are driven: the transform fault surfaces at the
    // corpus's first transform vector, the verify fault at its first vector.
    // The fixture runner's own suite pins the same standard for wire
    // fixtures.
    for (const fault of ["transform", "verify"] as const) {
      const broken: JobsSigningVectorHarness = {
        async sign({ typ, keyId, claims }) {
          return signJobsInstructionClaims(typ, claims, vectorKeyFor(keyId));
        },
        transform:
          fault === "transform"
            ? () => {
                throw new Error("mirror transform exploded");
              }
            : implementJobsVectorTransform,
        async verify({ token, keyId, expected, nowS }) {
          if (fault === "verify") throw new Error("mirror verify exploded");
          const verdict: JobsInstructionVerifyResult = await verifyJobsInstruction(
            token,
            vectorKeyFor(keyId),
            expected,
            nowS,
          );
          return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
        },
      };
      const faultVector =
        fault === "transform"
          ? "a flipped signature character"
          : "a keyed submit instruction verifies";
      await expect(runJobsSigningVectors(broken), `a throwing ${fault}`).rejects.toThrow(
        new RegExp(`vector "${faultVector}"`),
      );
    }
  });

  it("a throwing sign callback is a named failure and the corpus still runs past it", async () => {
    // The sign callback is the third wrapped callback; and a fault must strand
    // no later judgment. Sign faults on the snapshot family (the first fault
    // lands at "a snapshot instruction verifies") while a LATER vector's
    // verdict is also wrong — the report must name the sign fault AND the
    // later verdict mismatch, which an aborted run could never produce: the
    // abort would stop at the fault with only the entries behind it.
    const broken: JobsSigningVectorHarness = {
      sign: async ({ typ, keyId, claims }) => {
        if (claims.operation === "snapshot") throw new Error("mirror sign exploded");
        return signJobsInstructionClaims(typ, claims, vectorKeyFor(keyId));
      },
      transform: implementJobsVectorTransform,
      verify: async ({ token, keyId, expected, nowS }) => {
        if (expected.operation === "cancel") return { ok: false, reason: "signature" };
        const verdict: JobsInstructionVerifyResult = await verifyJobsInstruction(
          token,
          vectorKeyFor(keyId),
          expected,
          nowS,
        );
        return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
      },
    };
    await expect(runJobsSigningVectors(broken)).rejects.toThrow(
      /vector "a snapshot instruction verifies": the harness could not sign[\s\S]*"a cancel instruction verifies" expected acceptance — it failed with reason "signature"/,
    );
  });

  it("a throwing transform does not strand later judgments", async () => {
    // Continuation is pinned for sign faults above and for verify faults
    // below; the transform wrap is the same collect-and-continue shape, and
    // a runner that aborted at the first transform fault would pass the
    // naming test — the faulting vector's name appears in an abort's report
    // too. The corpus's only flip-signature vector sits near the END, so the
    // later evidence must be a vector AFTER it: the lifetime-tolerance
    // vector's verdict is also wrong, and the report must carry the transform
    // fault AND that later mismatch, in that order — which an aborted run
    // could never produce.
    const broken: JobsSigningVectorHarness = {
      async sign({ typ, keyId, claims }) {
        return signJobsInstructionClaims(typ, claims, vectorKeyFor(keyId));
      },
      transform: (token, kind) => {
        if (kind === "flip-signature-char") throw new Error("mirror transform exploded");
        return implementJobsVectorTransform(token, kind);
      },
      verify: async ({ token, keyId, expected, nowS }) => {
        // The expiry-tolerance vector sits after the transform vector and is
        // the only one presenting this clock.
        if (nowS === IAT + 36) return { ok: true };
        const verdict: JobsInstructionVerifyResult = await verifyJobsInstruction(
          token,
          vectorKeyFor(keyId),
          expected,
          nowS,
        );
        return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
      },
    };
    await expect(runJobsSigningVectors(broken)).rejects.toThrow(
      /vector "a flipped signature character": the harness could not transform[\s\S]*"one second past the expiry tolerance fails" expected rejection with reason "expired" — the instruction verified/,
    );
  });

  it("reports a verify verdict that resolves to nothing as a named vector failure", async () => {
    // The three callbacks' throws are wrapped, but the resolved verdict's own
    // shape is read outside any guard: a mirror whose verify resolves to
    // something `verdict.ok` cannot survive — null, undefined, or an object
    // whose ok is a throwing getter — crashes the judgment with a bare
    // exception — no vector named, the rest of the corpus stranded — the
    // same defect class the callback wraps closed, arriving by resolution
    // instead of by throw. A garbage verdict is the mirror's fault and must
    // be reported as the vector's failure, like every other harness fault.
    // A shape-guard for null alone would leave the getter shape crashing,
    // so the class is driven here, not one instance of it.
    const garbageVerdicts: readonly {
      readonly label: string;
      readonly verdict: () => unknown;
    }[] = [
      { label: "null", verdict: () => null },
      { label: "undefined", verdict: () => undefined },
      {
        label: "a throwing ok getter",
        verdict: () => {
          return {
            get ok(): never {
              throw new Error("verdict getter exploded");
            },
          };
        },
      },
    ];
    for (const { label, verdict: garbageVerdict } of garbageVerdicts) {
      const broken: JobsSigningVectorHarness = {
        async sign({ typ, keyId, claims }) {
          return signJobsInstructionClaims(typ, claims, vectorKeyFor(keyId));
        },
        transform: implementJobsVectorTransform,
        // The corpus judges non-TypeScript mirrors, whose resolved verdict
        // crosses this seam untyped — the one cast stands in for that
        // boundary; the garbage shape is the finding's subject.
        verify: async () => garbageVerdict() as unknown as JobsVectorVerdict,
      };
      await expect(runJobsSigningVectors(broken), `a verify resolving to ${label}`).rejects.toThrow(
        /vector "a keyed submit instruction verifies"/,
      );
    }
  });

  it("a sign or transform resolving to nothing is named for the callback that resolved", async () => {
    // The same resolution fault class the verify guard closed, arriving from
    // the other two callbacks: a mirror's sign or transform that resolves to
    // nothing hands the runner a token that does not exist. The fault must be
    // named for the callback that produced it — "the harness could not
    // sign" / "could not transform" — not for whichever callback later
    // crashed on the garbage, and the corpus must keep running: a later
    // vector's verdict mismatch must appear in the same report, which an
    // aborted run could never produce. The casts stand in for the untyped
    // mirror boundary, as in the verify test above.
    let signCalls = 0;
    const nothingShapes: readonly unknown[] = [undefined, null, 42];
    const broken: JobsSigningVectorHarness = {
      sign: async ({ typ, keyId, claims }) => {
        signCalls += 1;
        const shape = nothingShapes[signCalls - 1];
        if (signCalls <= nothingShapes.length) return shape as unknown as string;
        return signJobsInstructionClaims(typ, claims, vectorKeyFor(keyId));
      },
      transform: (token, kind) =>
        kind === "flip-signature-char"
          ? (undefined as unknown as string)
          : implementJobsVectorTransform(token, kind),
      verify: async ({ token, keyId, expected, nowS }) => {
        if (expected.operation === "cancel") return { ok: false, reason: "signature" };
        const verdict: JobsInstructionVerifyResult = await verifyJobsInstruction(
          token,
          vectorKeyFor(keyId),
          expected,
          nowS,
        );
        return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
      },
    };
    let message = "";
    try {
      await runJobsSigningVectors(broken);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("jobs signing vectors failed");
    // Every "nothing" shape resolves through the sign guard, each named for
    // sign — the first three vectors fault, the rest of the corpus proceeds.
    for (const vectorName of [
      "a keyed submit instruction verifies",
      "a keyless submit binds the explicit null",
      "a dev-tier submit verifies",
    ]) {
      expect(
        message,
        `the sign fault must be named for sign, not for the callback that crashed on the garbage token (${vectorName})`,
      ).toContain(`vector "${vectorName}": the harness could not sign`);
    }
    expect(message, "the transform fault must be named for transform").toContain(
      "the harness could not transform",
    );
    expect(
      message,
      "the corpus must run past the faults — a later vector's verdict mismatch is in the same report",
    ).toContain('"a cancel instruction verifies" expected acceptance');
  });

  it("a verify fault does not strand later judgments", async () => {
    // The continuation property is pinned for sign faults above; the verify
    // wrap is the same collect-and-continue shape, and a runner that rethrew
    // its named verify faults would pass every naming test here while
    // stranding the corpus again. The verify faults on the corpus's first
    // vector only; a later vector's verdict mismatch must appear in the same
    // report, which an aborted run could never produce.
    let verifyCalls = 0;
    const broken: JobsSigningVectorHarness = {
      async sign({ typ, keyId, claims }) {
        return signJobsInstructionClaims(typ, claims, vectorKeyFor(keyId));
      },
      transform: implementJobsVectorTransform,
      verify: async ({ token, keyId, expected, nowS }) => {
        verifyCalls += 1;
        if (verifyCalls === 1) return null as unknown as JobsVectorVerdict;
        if (expected.operation === "cancel") return { ok: false, reason: "signature" };
        const verdict: JobsInstructionVerifyResult = await verifyJobsInstruction(
          token,
          vectorKeyFor(keyId),
          expected,
          nowS,
        );
        return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
      },
    };
    let message = "";
    try {
      await runJobsSigningVectors(broken);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(
      'vector "a keyed submit instruction verifies": the harness could not verify',
    );
    expect(
      message,
      "the corpus must run past the verify fault — a later vector's verdict mismatch is in the same report",
    ).toContain('"a cancel instruction verifies" expected acceptance');
  });
});
