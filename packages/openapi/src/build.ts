/**
 * Builds the published OpenAPI documents from the route contracts (ADR-0054).
 * Build-time only: nothing at runtime imports this package's code, only its
 * committed `spec/*.json` output.
 */
import { createDocument, type ZodOpenApiObject, type ZodOpenApiOperationObject } from "zod-openapi";
import { z } from "zod";
import {
  appContracts,
  portalContracts,
  toOpenApiPath,
  type ContractApi,
  type MediaSpec,
  type RouteContract,
} from "@azx-pbc/shared/contracts";

/**
 * The documents' `info.version`. It is fixed so the output depends only on the
 * contracts; the deployed portal serves the spec of its own build.
 */
export const SPEC_VERSION = "v1";

const DOCUMENTS: Record<
  ContractApi,
  { title: string; description: string; contracts: readonly RouteContract[] }
> = {
  portal: {
    title: "Helix portal API",
    description:
      "The control-plane API the `helix` CLI, the portal UI and operator automation call. " +
      "Every route except the configuration bootstrap needs a bearer token.",
    contracts: portalContracts,
  },
  app: {
    title: "Helix app API",
    description:
      "The same-origin `/_api/*` gateway a hosted app calls from the browser: identity, " +
      "LLM, app data, connected accounts, the fetch proxy, and background jobs. " +
      "Requests are made from the app's own origin and carry the `__Host-session` cookie.",
    contracts: appContracts,
  },
};

const SECURITY_SCHEMES = {
  bearer: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "An IdP-issued token from `helix login`, or a portal dev token.",
  },
  session: {
    type: "apiKey",
    in: "cookie",
    name: "__Host-session",
    description: "The app host's session cookie, set by the platform's sign-in flow.",
  },
  oidcCi: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "A GitHub Actions OIDC token for a repo-backed app (ADR-0051).",
  },
} as const;

function security(auth: RouteContract["auth"]): ZodOpenApiOperationObject["security"] {
  switch (auth) {
    case "bearer":
      return [{ bearer: [] }];
    case "session":
      return [{ session: [] }];
    case "session-optional":
      return [{ session: [] }, {}];
    case "oidc-ci":
      return [{ oidcCi: [] }];
    case "none":
      return [];
  }
}

/** A media type with no schema still needs one in the document; any value is allowed. */
function content(specs: Record<string, MediaSpec>) {
  return Object.fromEntries(
    Object.entries(specs).map(([type, spec]) => [
      type,
      {
        schema: spec.schema ?? z.unknown(),
        ...(spec.description === undefined ? {} : { description: spec.description }),
      },
    ]),
  );
}

function operation(c: RouteContract): ZodOpenApiOperationObject {
  const responses = Object.fromEntries(
    Object.entries(c.responses).map(([status, r]) => [
      status,
      {
        description: r.description,
        ...(r.headers ? { headers: r.headers } : {}),
        ...(r.content ? { content: content(r.content) } : {}),
      },
    ]),
  );
  const requestParams = {
    ...(c.params ? { path: c.params } : {}),
    ...(c.query ? { query: c.query } : {}),
    ...(c.headers ? { header: c.headers } : {}),
  };
  return {
    operationId: c.id,
    tags: [...c.tags],
    summary: c.summary,
    ...(c.description ? { description: c.description } : {}),
    ...(Object.keys(requestParams).length > 0 ? { requestParams } : {}),
    ...(c.body
      ? {
          requestBody: {
            content: content(c.body.content),
            required: c.body.required ?? true,
            ...(c.body.description ? { description: c.body.description } : {}),
          },
        }
      : {}),
    responses,
    security: security(c.auth),
    ...(c.externalDocs ? { externalDocs: c.externalDocs } : {}),
    ...(c.admin ? { "x-helix-admin": true } : {}),
  };
}

/** Build one published document. */
export function buildDocument(api: ContractApi): ReturnType<typeof createDocument> {
  const doc = DOCUMENTS[api];
  const paths: NonNullable<ZodOpenApiObject["paths"]> = {};
  for (const c of doc.contracts) {
    const path = toOpenApiPath(c.path);
    const item = (paths[path] ??= {});
    const method = c.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
    if (item[method]) throw new Error(`duplicate contract for ${c.method} ${c.path}`);
    item[method] = operation(c);
  }
  const usedSchemes = new Set(
    doc.contracts.map((c) =>
      c.auth === "session-optional" ? "session" : c.auth === "oidc-ci" ? "oidcCi" : c.auth,
    ),
  );
  const securitySchemes = Object.fromEntries(
    Object.entries(SECURITY_SCHEMES).filter(([name]) => usedSchemes.has(name as never)),
  );
  return createDocument({
    openapi: "3.1.0",
    info: { title: doc.title, version: SPEC_VERSION, description: doc.description },
    paths,
    components: { securitySchemes },
  });
}

/** Serialize a document the way the committed files are written. */
export function serialize(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
