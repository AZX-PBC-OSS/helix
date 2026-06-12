import { z } from "zod";
import {
  ApiErrorSchema,
  AppSchema,
  UploadVersionResponseSchema,
  VersionSchema,
  type App,
  type UploadVersionResponse,
  type Version,
  type Visibility,
} from "@helix/shared";

/** A CLI-level error carrying the portal's error code when available. */
export class CliError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

export interface CreateAppInput {
  slug: string;
  displayName: string;
  visibility?: Visibility;
}

const VersionListSchema = z.array(VersionSchema);

/** Typed client for the portal REST API; responses are validated with the shared schemas. */
export class PortalClient {
  readonly #baseUrl: string;
  readonly #token?: string;

  constructor(baseUrl: string, token?: string) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#token = token;
  }

  createApp(input: CreateAppInput): Promise<App> {
    return this.#json(AppSchema, "POST", "/api/v1/apps", { auth: true, body: input });
  }

  listVersions(slug: string): Promise<Version[]> {
    return this.#json(VersionListSchema, "GET", `/api/v1/apps/${enc(slug)}/versions`, {});
  }

  promote(slug: string, number: number): Promise<App> {
    return this.#json(AppSchema, "POST", `/api/v1/apps/${enc(slug)}/versions/${number}/promote`, {
      auth: true,
    });
  }

  rollback(slug: string, toNumber?: number): Promise<App> {
    return this.#json(AppSchema, "POST", `/api/v1/apps/${enc(slug)}/rollback`, {
      auth: true,
      body: toNumber !== undefined ? { toNumber } : {},
    });
  }

  async uploadVersion(
    slug: string,
    zip: Buffer,
    filename = "bundle.zip",
  ): Promise<UploadVersionResponse> {
    const form = new FormData();
    form.append("bundle", new Blob([new Uint8Array(zip)]), filename);
    const res = await fetch(this.#url(`/api/v1/apps/${enc(slug)}/versions`), {
      method: "POST",
      headers: this.#authHeaders(true),
      body: form,
    });
    return this.#parse(UploadVersionResponseSchema, res);
  }

  #url(path: string): string {
    return `${this.#baseUrl}${path}`;
  }

  #authHeaders(auth: boolean): Record<string, string> {
    if (!auth) return {};
    if (!this.#token) {
      throw new CliError("no deploy token; set AZX_TOKEN or pass --token");
    }
    return { authorization: `Bearer ${this.#token}` };
  }

  async #json<T>(
    schema: z.ZodType<T>,
    method: string,
    path: string,
    opts: { auth?: boolean; body?: unknown },
  ): Promise<T> {
    const headers = this.#authHeaders(opts.auth ?? false);
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(this.#url(path), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    return this.#parse(schema, res);
  }

  async #parse<T>(schema: z.ZodType<T>, res: Response): Promise<T> {
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const parsed = ApiErrorSchema.safeParse(data);
      if (parsed.success) throw new CliError(parsed.data.error.message, parsed.data.error.code);
      throw new CliError(`request failed (HTTP ${res.status})`);
    }
    return schema.parse(data);
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
