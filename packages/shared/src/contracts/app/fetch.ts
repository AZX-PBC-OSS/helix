// Contracts for the edge's /_api/fetch routes (ADR-0054).
import { z } from "zod";
import { FetchProxyErrorSchema, REQUEST_HEADER_SAFELIST } from "../../fetch.js";
import { jsonResponse, type BodySpec, type HttpMethod, type ResponseSpec } from "../define.js";
import { appRoute, RetryAfterHeader } from "./common.js";

const tags = ["Fetch proxy"] as const;

const forwarded = REQUEST_HEADER_SAFELIST.map((h) => `\`${h}\``).join(", ");

const DESCRIPTION =
  "Calls an external origin the app's manifest grants, through the platform. Put the whole " +
  "target URL after the prefix, either raw or percent-encoded: " +
  "`fetch('/_api/fetch/https://api.example.com/v1/items?q=1')`. The call is same-origin, so " +
  "it needs no CSP change. When the grant has a connection secret or a delegated user " +
  "connection, the platform adds the credential; the app never sees it.\n\n" +
  "The method, the body and these request headers are forwarded: " +
  `${forwarded}. Every other header, \`Cookie\` and \`Authorization\` included, is dropped. ` +
  "The edge also reads `Origin` (it must be the app's own, a CSRF check), the session " +
  "cookie, and `Content-Length` (a declared body over the size cap is refused before the " +
  "call).\n\n" +
  "The upstream's response comes back with its own status, headers and body, streamed. The " +
  "platform removes `Set-Cookie`, `Location`, credential and hop-by-hop headers, and caching " +
  "headers, and answers `Cache-Control: no-store`. Upstream redirects are not followed. A body " +
  "over the size cap is truncated, because the status is already sent.\n\n" +
  "When the platform refuses a call instead, the body is a `FetchProxyError` JSON object: " +
  "`{ code, message }`, with `provider` on the delegated-connection codes. The statuses below " +
  "list the refusals; the platform's connection service can also answer `connection_required` " +
  "(403), `replay` (409), `provider_misconfigured` (502) and `provider_unavailable` (503) " +
  "with the same shape.";

const params = z.object({
  "*": z.string().meta({
    description: "The target URL, `http:` or `https:`, raw or percent-encoded.",
  }),
});

const headers = z.object({
  origin: z
    .string()
    .optional()
    .meta({ description: "Must be the app's own origin (CSRF check). Browsers send it." }),
  "content-length": z
    .string()
    .optional()
    .meta({ description: "A declared body over the size cap is refused with 413 up front." }),
});

function refusal(description: string): ResponseSpec {
  return jsonResponse(FetchProxyErrorSchema, description);
}

const responses = {
  200: {
    description:
      "The upstream's response, passed through. The upstream's own status applies; any status " +
      "is possible, and this entry stands for all of them.",
    content: { "*/*": { description: "The upstream's body, streamed." } },
  },
  400: refusal("The target URL is missing, malformed, or not http(s) (`bad_target`)."),
  403: refusal(
    "The target origin is not granted to the app, or the `Origin` is not the app's own " +
      "(`forbidden`); or the grant needs a delegated connection the caller does not have " +
      "(`connection_required`, with `provider`).",
  ),
  413: refusal("The request body exceeds the size cap (`too_large`)."),
  429: {
    ...refusal(
      "The app's daily fetch budget, or the anonymous per-IP budget, is exhausted (`rate_limited`).",
    ),
    headers: RetryAfterHeader.partial(),
  },
  502: refusal("The platform's egress or the upstream call failed (`upstream_error`)."),
  503: refusal("The fetch capability is not configured on this deployment (`upstream_error`)."),
} satisfies Record<number, ResponseSpec>;

const body: BodySpec = {
  required: false,
  description: "Any body, forwarded byte for byte with its `Content-Type`. Not parsed.",
  content: { "*/*": { description: "Passed through unchanged." } },
};

function fetchRoute<const M extends HttpMethod>(method: M, withBody: boolean) {
  const name = method.charAt(0) + method.slice(1).toLowerCase();
  return appRoute({
    id: `fetchProxy${name}`,
    method,
    path: "/_api/fetch/*",
    tags,
    summary: `Proxy a ${method} request to an external origin`,
    description: DESCRIPTION,
    params,
    headers,
    ...(withBody ? { body } : {}),
    responses,
  });
}

export const fetchProxyGet = fetchRoute("GET", false);
export const fetchProxyPost = fetchRoute("POST", true);
export const fetchProxyPut = fetchRoute("PUT", true);
export const fetchProxyPatch = fetchRoute("PATCH", true);
export const fetchProxyDelete = fetchRoute("DELETE", true);
export const fetchProxyOptions = fetchRoute("OPTIONS", false);

/** One contract per method; `HEAD` is served with `GET`. */
export const fetchContracts = [
  fetchProxyGet,
  fetchProxyPost,
  fetchProxyPut,
  fetchProxyPatch,
  fetchProxyDelete,
  fetchProxyOptions,
] as const;
