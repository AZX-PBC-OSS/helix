import type { z } from "zod";
import { ApiErrorSchema, type ApiErrorCode } from "@azx-pbc/shared";
import { getToken } from "../auth/tokenStore";

/**
 * The portal API boundary: every response is zod-parsed (same religion as the
 * server side), every non-2xx becomes a typed {@link PortalApiError} from the
 * uniform error envelope. Paths are same-origin — the Vite dev server proxies
 * /api to the portal, and in prod the portal serves this bundle itself.
 */

export class PortalApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "PortalApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function throwApiError(res: Response): Promise<never> {
  let parsed;
  try {
    parsed = ApiErrorSchema.parse(await res.json());
  } catch {
    throw new PortalApiError("internal", `unexpected ${res.status} response`, res.status);
  }
  const { code, message, details } = parsed.error;
  throw new PortalApiError(code, message, res.status, details);
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchJson<Schema extends z.ZodType>(
  schema: Schema,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<z.output<Schema>> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...authHeaders(),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) await throwApiError(res);
  return schema.parse(await res.json()) as z.output<Schema>;
}

/** A mutation with no response body (e.g. a 204 DELETE) — errors still typed. */
export async function requestVoid(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<void> {
  const res = await fetch(path, {
    method: init.method ?? "POST",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...authHeaders(),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) await throwApiError(res);
}

/**
 * A non-JSON GET (the CSV export), returning the body and the response headers.
 *
 * Not `<a href="…">`: a browser navigation carries no `Authorization` header, so
 * the download has to go through fetch and be handed to the user as a Blob. The
 * headers come back because the export signals truncation out-of-band, in
 * `x-helix-export-truncated`, and silently dropping that would present a short
 * file as a complete one.
 */
export async function fetchText(path: string): Promise<{ body: string; headers: Headers }> {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) await throwApiError(res);
  return { body: await res.text(), headers: res.headers };
}

/** Multipart upload (the deploy endpoint) — browser sets the boundary header. */
export async function uploadFile<Schema extends z.ZodType>(
  schema: Schema,
  path: string,
  fieldName: string,
  file: File,
): Promise<z.output<Schema>> {
  const form = new FormData();
  form.append(fieldName, file);
  const res = await fetch(path, { method: "POST", headers: authHeaders(), body: form });
  if (!res.ok) await throwApiError(res);
  return schema.parse(await res.json()) as z.output<Schema>;
}
