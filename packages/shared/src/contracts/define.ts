/**
 * Route contracts (ADR-0054): one declaration per published HTTP route, holding
 * the zod schemas the handler validates with and the OpenAPI generator documents
 * from. The handler and the spec read the same schema object, so they can only
 * disagree if a test or the generator is skipped.
 *
 * This module is pure zod. The edge imports `@azx-pbc/shared` at runtime, so
 * nothing here may pull in an OpenAPI or Fastify package.
 */
import { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

/** Which published document a contract belongs to. */
export type ContractApi = "portal" | "app";

/**
 * How a caller authenticates.
 *
 * - `bearer`: portal bearer token (IdP JWT or dev token, ADR-0024).
 * - `session`: the app host's `__Host-session` cookie; required.
 * - `session-optional`: the session is read when present. Public apps accept
 *   anonymous callers.
 * - `oidc-ci`: a GitHub Actions OIDC token (ADR-0051).
 * - `none`: public.
 */
export type ContractAuth = "bearer" | "session" | "session-optional" | "oidc-ci" | "none";

/** One media type in a request or response body. A missing schema documents the type only. */
export interface MediaSpec {
  schema?: z.ZodType;
  description?: string;
}

export interface ResponseSpec {
  description: string;
  /** Keyed by media type. Absent for an empty body (204, 302). */
  content?: Record<string, MediaSpec>;
  /** Response headers worth documenting, as a zod object of string schemas. */
  headers?: z.ZodObject;
}

export interface BodySpec {
  /** Keyed by media type. */
  content: Record<string, MediaSpec>;
  required?: boolean;
  description?: string;
}

export interface RouteContract<
  P extends z.ZodObject | undefined = z.ZodObject | undefined,
  Q extends z.ZodObject | undefined = z.ZodObject | undefined,
  B extends BodySpec | undefined = BodySpec | undefined,
  R extends Record<number, ResponseSpec> = Record<number, ResponseSpec>,
> {
  /** Unique operation id, used as the OpenAPI `operationId`. */
  id: string;
  api: ContractApi;
  method: HttpMethod;
  /** Fastify path syntax: `:param`, and a trailing `*` for a wildcard. */
  path: string;
  auth: ContractAuth;
  /** The handler requires the platform-admin role (checked in the handler, not a preHandler). */
  admin?: boolean;
  tags: readonly string[];
  summary: string;
  description?: string;
  params?: P;
  query?: Q;
  headers?: z.ZodObject;
  body?: B;
  responses: R;
  /** A link to an external reference, e.g. OpenAI's own spec. */
  externalDocs?: { url: string; description?: string };
}

/** Identity helper that keeps the literal types of a contract. */
export function defineRoute<
  const P extends z.ZodObject | undefined = undefined,
  const Q extends z.ZodObject | undefined = undefined,
  const B extends BodySpec | undefined = undefined,
  const R extends Record<number, ResponseSpec> = Record<number, ResponseSpec>,
>(contract: RouteContract<P, Q, B, R>): RouteContract<P, Q, B, R> {
  return contract;
}

// ── Body and response helpers ──

export const JSON_MEDIA = "application/json";

/** The media map of a JSON body or response, keeping the schema's type. */
// A type alias, not an interface: only an alias is assignable to the
// `Record<string, MediaSpec>` index signature.
export type JsonContent<S extends z.ZodType> = {
  [JSON_MEDIA]: { schema: S; description?: string };
};

/** A JSON body or response. */
export function json<S extends z.ZodType>(schema: S, description?: string): JsonContent<S> {
  return { [JSON_MEDIA]: { schema, ...(description === undefined ? {} : { description }) } };
}

/** A JSON request body. */
export function jsonBody<S extends z.ZodType>(
  schema: S,
  description?: string,
): BodySpec & { content: JsonContent<S> } {
  return { content: json(schema), required: true, ...(description ? { description } : {}) };
}

/** A non-JSON media type documented by name, with an optional schema. */
export function media(
  type: string,
  description?: string,
  schema?: z.ZodType,
): Record<string, MediaSpec> {
  return {
    [type]: {
      ...(schema === undefined ? {} : { schema }),
      ...(description === undefined ? {} : { description }),
    },
  };
}

/** A response with a JSON body. */
export function jsonResponse<S extends z.ZodType>(
  schema: S,
  description: string,
): ResponseSpec & { content: JsonContent<S> } {
  return { description, content: json(schema) };
}

/** A response with no body. */
export function emptyResponse(description: string): ResponseSpec {
  return { description };
}

// ── Request validation ──

/** The request part a validation failure came from. */
export type RequestPart = "params" | "query" | "headers" | "body";

/**
 * A request failed its contract. Services map this to a 400 `validation_failed`.
 * It is a distinct class so that a `ZodError` thrown anywhere else, such as a
 * handler parsing its own response, is never mistaken for the caller's fault.
 */
export class RequestValidationError extends Error {
  readonly part: RequestPart;
  readonly issues: z.core.$ZodIssue[];

  constructor(part: RequestPart, issues: z.core.$ZodIssue[]) {
    super(`request ${part} failed validation`);
    this.name = "RequestValidationError";
    this.part = part;
    this.issues = issues;
  }
}

type Out<S> = S extends z.ZodType ? z.output<S> : undefined;

/** The JSON schema of a body spec, or undefined when the body is not JSON. */
type JsonBodySchema<B> = B extends { content: { [JSON_MEDIA]: { schema: infer S } } }
  ? S
  : undefined;

export interface ParsedRequest<P, Q, B> {
  params: Out<P>;
  query: Out<Q>;
  body: Out<JsonBodySchema<B>>;
}

/** The parts of a request `parseRequest` reads. Structural, so shared needs no Fastify types. */
export interface RequestParts {
  params?: unknown;
  query?: unknown;
  body?: unknown;
}

function parsePart<S extends z.ZodType>(part: RequestPart, schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new RequestValidationError(part, result.error.issues);
  return result.data;
}

/**
 * Validate a request against its contract and return the parsed parts.
 *
 * Only a JSON body is parsed. Multipart and raw bodies are documented by the
 * contract but read by the handler itself.
 */
export function parseRequest<
  P extends z.ZodObject | undefined,
  Q extends z.ZodObject | undefined,
  B extends BodySpec | undefined,
>(contract: RouteContract<P, Q, B>, req: RequestParts): ParsedRequest<P, Q, B> {
  const params = contract.params ? parsePart("params", contract.params, req.params) : undefined;
  const query = contract.query ? parsePart("query", contract.query, req.query ?? {}) : undefined;
  const bodySchema = contract.body?.content[JSON_MEDIA]?.schema;
  const body = bodySchema ? parsePart("body", bodySchema, req.body) : undefined;
  return { params, query, body } as ParsedRequest<P, Q, B>;
}

/** The JSON schema a contract declares for one status. */
type ResponseSchema<R, S> = S extends keyof R
  ? R[S] extends { content: { [JSON_MEDIA]: { schema: infer T } } }
    ? T
    : never
  : never;

/**
 * Parse a response body through the schema the contract declares for `status`.
 * A mismatch throws a plain `ZodError`, which the services report as a 500,
 * because it is the platform's fault and not the caller's.
 */
export function responseBody<R extends Record<number, ResponseSpec>, S extends keyof R & number>(
  contract: RouteContract<
    z.ZodObject | undefined,
    z.ZodObject | undefined,
    BodySpec | undefined,
    R
  >,
  status: S,
  value: z.input<ResponseSchema<R, S> & z.ZodType>,
): z.output<ResponseSchema<R, S> & z.ZodType> {
  const schema = contract.responses[status]?.content?.[JSON_MEDIA]?.schema;
  if (!schema) {
    throw new Error(`contract ${contract.id} declares no JSON body for ${String(status)}`);
  }
  return schema.parse(value) as z.output<ResponseSchema<R, S> & z.ZodType>;
}

/** Fastify `:param` / `*` path → OpenAPI `{param}` path. The wildcard is named `path`. */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\*$/, "{path}");
}
