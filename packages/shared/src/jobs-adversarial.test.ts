import { describe, expect, it } from "vitest";

import {
  JOB_ERROR_CODES,
  JOB_REQUEST_ERROR_CODES,
  JOB_STATEFUL_ERROR_CODES,
  JobErrorMessages,
  JobErrorSchema,
  JobReferenceSchema,
  JobRequestErrorSchema,
  JobSnapshotSchema,
  jobError,
  jobRequestError,
  FetchJobInputSchema,
  FetchJobResultSchema,
  JOBS_MAX_RESULT_BYTES,
} from "./jobs.js";

const SNAPSHOT = {
  server: "jobs",
  jobId: "w9QZzaBp4XkR3tYm017c3",
  type: "jobs:fetch",
  status: "succeeded",
  attempt: 1,
  progress: null,
  cancellationRequested: false,
  resultExpiresAt: null,
  recordExpiresAt: null,
  error: null,
};

describe("fetch input URL fidelity", () => {
  it("a padded URL is malformed, not a value to repair", () => {
    // The submitted URL is the durable job input. A schema that accepts it
    // must either keep the submitted bytes or refuse them; silently handing
    // back a different string launders the value through the boundary.
    expect(FetchJobInputSchema.safeParse({ url: "  https://example.com/x  " }).success).toBe(false);
    expect(FetchJobInputSchema.safeParse({ url: "\nhttps://example.com/x" }).success).toBe(false);
  });

  it("a URL carrying interior control characters is malformed — the validated value must be the value fetched", () => {
    // The URL grammar forbids raw control characters; the WHATWG parser
    // tolerates them by stripping before parsing, so a schema built on
    // `new URL()` validates one URL and forwards another. The input must be
    // rejected instead of parsed past characters the grammar does not allow.
    expect(FetchJobInputSchema.safeParse({ url: "https://exa\nmple.com/x" }).success).toBe(false);
    expect(FetchJobInputSchema.safeParse({ url: "https://example.com/x?y=a\tb" }).success).toBe(
      false,
    );
  });

  it("the control scan covers DEL but not C1 — the one-past range stays fetchable", () => {
    // The scan's range is C0 controls plus DEL (0x7f), stopping before C1
    // (0x80–0x9f): the URL parser never strips C1 — it percent-encodes them
    // deterministically — so a C1 character keeps the validated value equal
    // to the fetched value. Dropping DEL from the scan or sweeping C1 in
    // would each flip one of these assertions.
    expect(FetchJobInputSchema.safeParse({ url: "https://example.com/x\u007fy" }).success).toBe(
      false,
    );
    expect(FetchJobInputSchema.safeParse({ url: "https://example.com/x\u0080y" }).success).toBe(
      true,
    );
  });
});

describe("result contract crash safety", () => {
  it("a wire-legal result at the byte cap gets a verdict — safeParse never throws", () => {
    // The 64 KiB cap is inclusive, so a result may legally nest 32,766 deep
    // ("[" repeated 32,766 + "null" + "]" repeated 32,766 = 65,536 bytes) —
    // well within what JSON.parse produces from an upstream body. Judging it
    // must return a discriminated result, never a RangeError: an upstream
    // that sends this shape would crash the validating request instead of
    // drawing a sanitized result rejection.
    const depth = (JOBS_MAX_RESULT_BYTES - 4) / 2;
    const wire = "[".repeat(depth) + "null" + "]".repeat(depth);
    expect(wire.length).toBe(JOBS_MAX_RESULT_BYTES);
    const deep: unknown = JSON.parse(wire);

    let verdict: { success: boolean } | undefined;
    expect(() => {
      verdict = FetchJobResultSchema.safeParse(deep);
    }).not.toThrow();
    expect(verdict?.success).toBe(true);
  });

  it("a cyclic value gets a refusal verdict, and sharing is not a cycle", () => {
    // The checker's open-set bookkeeping exists so a cyclic in-memory value
    // is refused instead of walked forever — if it is simplified away, the
    // parse hangs and nothing else in the suite goes red. A structure that
    // references one object twice shares subvalues without cycling; refusing
    // that would reject legal results.
    const selfReferring: Record<string, unknown> = { ok: true };
    selfReferring.self = selfReferring;
    const selfReferringList: unknown[] = ["x"];
    selfReferringList.push(selfReferringList);

    let objectVerdict: { success: boolean } | undefined;
    expect(() => {
      objectVerdict = FetchJobResultSchema.safeParse(selfReferring);
    }).not.toThrow();
    expect(objectVerdict?.success).toBe(false);

    let listVerdict: { success: boolean } | undefined;
    expect(() => {
      listVerdict = FetchJobResultSchema.safeParse(selfReferringList);
    }).not.toThrow();
    expect(listVerdict?.success).toBe(false);

    const shared = { x: 1 };
    expect(FetchJobResultSchema.safeParse({ a: shared, b: shared, list: [shared] }).success).toBe(
      true,
    );
  });
});

describe("strict object unknown-key completeness", () => {
  it("an own __proto__ key fails the parse instead of being shed", () => {
    // JSON.parse materializes a "__proto__" key as an own property, so a
    // request body can carry one to any strict schema. The strictness
    // contract is that a field a plane does not know fails its parse —
    // dropping the key silently would make this the one field that sheds.
    const input = JSON.parse('{"url":"https://example.com/x","__proto__":{"polluted":true}}');
    expect(FetchJobInputSchema.safeParse(input).success).toBe(false);

    const reference = JSON.parse('{"server":"jobs","jobId":"abc","__proto__":{"polluted":true}}');
    expect(JobReferenceSchema.safeParse(reference).success).toBe(false);

    // JobRequestErrorSchema composes the raw-input screen directly around the
    // union rather than through the helper the two above use — a refactor
    // that drops that pipe sheds here with the helper pins still green.
    const requestError = JSON.parse(
      `{"code":"rate_limited","message":${JSON.stringify(JobErrorMessages.rate_limited)},"__proto__":{"polluted":true}}`,
    );
    expect(JobRequestErrorSchema.safeParse(requestError).success).toBe(false);
  });
});

describe("the raw-input key screen at depth", () => {
  it("the screen holds at nesting depth — progress and a nested execution error refuse an own __proto__ key too", () => {
    // Every object in the contract is a wire object, not only the top-level
    // body: a refactor that inlines progress or the nested error as a plain
    // z.strictObject would restore the shed at that level while every
    // top-level pin here stays green. Escape-encoded JSON keys decode before
    // the screen runs, so "\u005f_proto__" cannot rename the field past it.
    const escaped = JSON.parse(
      '{"\\u005f_proto__":{"polluted":true},"server":"jobs","jobId":"abc"}',
    );
    expect(JobReferenceSchema.safeParse(escaped).success).toBe(false);

    expect(
      JobSnapshotSchema.safeParse({
        ...SNAPSHOT,
        progress: JSON.parse('{"step":0,"of":1,"label":"Fetching","__proto__":{"x":1}}'),
      }).success,
    ).toBe(false);

    const stateful = JSON.parse(
      `{"code":"job_not_ready","message":${JSON.stringify(JobErrorMessages.job_not_ready)},` +
        `"status":"running","error":{"code":"timeout","message":${JSON.stringify(
          JobErrorMessages.timeout,
        )},"__proto__":{"x":1}}}`,
    );
    // Every field of this body is otherwise valid — without the nested
    // screen the error object would parse (shedding __proto__) and the whole
    // body would be accepted, so the refusal here is attributable to the
    // screen at depth and nothing else.
    expect(JobRequestErrorSchema.safeParse(stateful).success).toBe(false);
  });

  it("only __proto__ is special — other Object.prototype member names fail the ordinary unrecognized-key check", () => {
    // The screen exists because exactly one key name skips zod's strict
    // check. If the screen is ever generalized or the strict check widened,
    // these must keep failing as unknown keys, not become silently shed.
    for (const key of ["constructor", "hasOwnProperty", "toString", "valueOf", "isPrototypeOf"]) {
      const body = JSON.parse(`{"server":"jobs","jobId":"abc","${key}":1}`);
      expect(JobReferenceSchema.safeParse(body).success, key).toBe(false);
    }
  });
});

describe("result values keep __proto__ as data", () => {
  it("a __proto__ key inside a JSON result is data, not a wire field — the result contract accepts it", () => {
    // The raw-key refusal is scoped to wire objects. A JSON result is any
    // value JSON could have produced, and '{"__proto__":1}' is valid JSON —
    // JSON.parse materializes the key as an own data property that
    // JSON.stringify re-serializes. Refusing it would reject legal upstream
    // responses; walking it is safe because nothing invokes it as a setter.
    const value: unknown = JSON.parse('{"__proto__":1,"ok":true}');
    expect(FetchJobResultSchema.safeParse(value).success).toBe(true);
    expect(JSON.stringify(value)).toBe('{"__proto__":1,"ok":true}');
  });
});

describe("the constructor's runtime guard under type bypass", () => {
  it("an explicit null state does not slide through as absent state on a stateful code", () => {
    // The guard tests `state === undefined`, and the return spreads `state`
    // into the base — but `{...base, ...null}` spreads to nothing, so a
    // caller that bypasses the types with `null` gets the exact bare
    // stateful body the contract forbids, silently. The same null on a
    // non-stateful code throws ("does not carry job state"), because there
    // `null !== undefined` trips the opposite guard — one input class, two
    // verdicts. The guard's doctrine is to keep the rule for callers that
    // bypassed the types; null is such a bypass and must be refused.
    const bypassed = jobRequestError as (
      code: string,
      state?: { status: "running"; error: null } | null,
    ) => unknown;
    expect(() => bypassed("job_not_ready", null)).toThrow(/requires the job's status and error/);
  });
});

describe("the self-check floor under the guard's blind spot", () => {
  it("state whose status and error are inherited, not own, defeats the in-guards — the self-check is the floor", () => {
    // `in` walks the prototype chain, so an own-field-less object inheriting
    // status and error passes both guard checks; the spread copies own
    // enumerable keys only, so the body it would build is the bare stateful
    // body the contract forbids. Only the unconditional self-check refuses
    // it — simplifying the self-check away as redundant with the guards
    // turns exactly this input into a silent bare body. Either layer may
    // refuse; what the contract forbids is returning one.
    const bypassed = jobRequestError as (code: string, state?: unknown) => unknown;
    const inherited: object = Object.create({ status: "running", error: null });
    expect(Object.getOwnPropertyNames(inherited).length).toBe(0);
    expect(() => bypassed("job_not_ready", inherited)).toThrow();
  });

  it("every constructed body parses against the aggregate's own schemas — the self-check and the export cannot drift", () => {
    // The constructors self-check against module-internal schema references;
    // this is the same claim witnessed from outside, through the published
    // aggregate. It goes red if the self-check is dropped and the
    // constructor's output drifts from the wire schema — and it exercises
    // every catalogue code, not the handful the suites parse by hand.
    for (const code of JOB_REQUEST_ERROR_CODES) {
      if ((JOB_STATEFUL_ERROR_CODES as readonly string[]).includes(code)) {
        expect(
          JobRequestErrorSchema.safeParse(
            jobRequestError(code as never, { status: "running", error: null }),
          ).success,
          code,
        ).toBe(true);
      } else {
        expect(JobRequestErrorSchema.safeParse(jobRequestError(code as never)).success, code).toBe(
          true,
        );
      }
    }
    for (const code of JOB_ERROR_CODES) {
      expect(JobErrorSchema.safeParse(jobError(code)).success, code).toBe(true);
    }
  });
});

describe("error catalogue injectivity", () => {
  it("no two catalogue codes share prose, so a message pins exactly one code", () => {
    // The fixed-message rule makes message == catalogue entry for the code;
    // that only identifies the code if the prose is unique across the
    // catalogue. A future duplicate would let one code's message vouch for
    // another, so every cross-code pair must fail both error schemas.
    for (const code of JOB_REQUEST_ERROR_CODES) {
      for (const other of JOB_REQUEST_ERROR_CODES) {
        if (other === code) continue;
        const body = { code, message: JobErrorMessages[other] };
        expect(JobRequestErrorSchema.safeParse(body).success, `${code} vs ${other}`).toBe(false);
        if ((JOB_ERROR_CODES as readonly string[]).includes(code)) {
          expect(JobErrorSchema.safeParse(body).success, `${code} vs ${other}`).toBe(false);
        }
      }
    }
  });
});

describe("expiry timestamp calendar realism", () => {
  it("an impossible calendar date is malformed even though the ISO grammar fits", () => {
    // Expiry boundaries are read with new Date(); a syntactically ISO string
    // that no calendar day exists for would parse here and return NaN there.
    for (const impossible of [
      "2026-02-30T12:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-02-29T00:00:00Z",
    ]) {
      expect(
        JobSnapshotSchema.safeParse({ ...SNAPSHOT, resultExpiresAt: impossible }).success,
        impossible,
      ).toBe(false);
    }
    expect(
      JobSnapshotSchema.safeParse({ ...SNAPSHOT, resultExpiresAt: "2028-02-29T00:00:00Z" }).success,
    ).toBe(true);
  });
});
