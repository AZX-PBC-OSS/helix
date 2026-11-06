/**
 * Response conformance (ADR-0054 decision 4): checks one recorded response
 * against its contract. Test harnesses call this from a Fastify `onSend` hook,
 * so it runs in tests only and never on a service's hot path.
 */
import { JSON_MEDIA, type RouteContract } from "./define.js";

export interface RecordedResponse {
  method: string;
  /** The matched route pattern (`request.routeOptions.url`), not the request URL. */
  route: string;
  status: number;
  contentType: string | undefined;
  /** The serialized payload, or undefined for a stream or an empty body. */
  body: string | undefined;
}

/** Index contracts by `METHOD path` for lookup from a matched route. */
export function indexContracts(
  contracts: readonly RouteContract[],
): ReadonlyMap<string, RouteContract> {
  const map = new Map<string, RouteContract>();
  for (const c of contracts) map.set(`${c.method} ${c.path}`, c);
  return map;
}

function mediaType(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

/**
 * Return a description of how the response breaks its contract, or null when
 * it conforms or no contract covers the route. Route coverage is a separate
 * test, so an uncovered route is not a conformance failure.
 */
export function checkResponse(
  index: ReadonlyMap<string, RouteContract>,
  res: RecordedResponse,
): string | null {
  const contract = index.get(`${res.method} ${res.route}`);
  if (!contract) return null;
  const where = `${contract.id} (${res.method} ${res.route}) → ${res.status}`;

  const spec = contract.responses[res.status];
  if (!spec) {
    const declared = Object.keys(contract.responses).join(", ");
    return `${where}: status not declared (declared: ${declared})`;
  }

  const type = mediaType(res.contentType);
  if (!spec.content) {
    if (res.body !== undefined && res.body.length > 0) {
      return `${where}: declared an empty body but sent ${type ?? "an untyped body"}`;
    }
    return null;
  }
  if (type === undefined) {
    // A stream piped without a content type, or an empty body on a typed status.
    return res.body ? `${where}: body sent without a content type` : null;
  }
  const media = spec.content[type];
  if (!media) {
    const declared = Object.keys(spec.content).join(", ");
    return `${where}: content type ${type} not declared (declared: ${declared})`;
  }
  if (type !== JSON_MEDIA || !media.schema || res.body === undefined) return null;

  let value: unknown;
  try {
    value = JSON.parse(res.body);
  } catch {
    return `${where}: body is not valid JSON`;
  }
  const result = media.schema.safeParse(value);
  if (result.success) return null;
  const issues = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return `${where}: body does not match the declared schema: ${issues}`;
}

/** The request fields the recorder reads. Structural, so shared needs no Fastify types. */
export interface RecorderRequest {
  method: string;
  routeOptions: { url?: string | undefined };
}

/** The reply fields the recorder reads. */
export interface RecorderReply {
  statusCode: number;
  getHeader(name: string): unknown;
}

export interface ConformanceRecorder {
  /** Register as a Fastify `onSend` hook. Records only; returns the payload unchanged. */
  onSend(req: RecorderRequest, reply: RecorderReply, payload: unknown): Promise<unknown>;
  /** Every contract violation recorded so far. */
  readonly violations: readonly string[];
  /** Throw when any response broke its contract. */
  assertNone(): void;
}

/**
 * Record contract violations for every response a test app sends. The hook
 * never changes a response, so a test observes exactly what production would;
 * the harness calls `assertNone()` when the app closes.
 */
export function conformanceRecorder(contracts: readonly RouteContract[]): ConformanceRecorder {
  const index = indexContracts(contracts);
  const violations: string[] = [];
  return {
    violations,
    async onSend(req, reply, payload) {
      const route = req.routeOptions.url;
      if (route === undefined || req.method === "HEAD") return payload;
      const body =
        typeof payload === "string"
          ? payload
          : payload instanceof Uint8Array
            ? new TextDecoder().decode(payload)
            : undefined;
      const contentType = reply.getHeader("content-type");
      const problem = checkResponse(index, {
        method: req.method,
        route,
        status: reply.statusCode,
        contentType: typeof contentType === "string" ? contentType : undefined,
        body,
      });
      if (problem) violations.push(problem);
      return payload;
    },
    assertNone() {
      if (violations.length > 0) {
        throw new Error(`responses broke their route contracts:\n  ${violations.join("\n  ")}`);
      }
    },
  };
}
