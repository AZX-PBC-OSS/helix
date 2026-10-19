import { z } from "zod";
import {
  ApiErrorSchema,
  AppSchema,
  AuthConfigResponseSchema,
  DeploymentConfigResponseSchema,
  PortalMeResponseSchema,
  RepoBindingSchema,
  UploadVersionResponseSchema,
  VersionSchema,
  type App,
  type AuthConfigResponse,
  type DeploymentConfigResponse,
  type PortalMeResponse,
  type RepoBinding,
  type SetRepoBindingRequest,
  type UploadVersionResponse,
  type Version,
  type Visibility,
} from "@azx-pbc/shared";
import type { TokenProvider } from "./auth/session.js";
import { CLI_VERSION } from "./version.js";

/** A CLI-level error carrying the portal's error code when available. */
export class CliError extends Error {
  readonly code?: string;
  /** The portal envelope's `details`, when it sent one. */
  readonly details?: unknown;
  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}

/** The `reason` a portal error carried in its details, if any. */
export function errorReason(err: unknown): string | undefined {
  if (!(err instanceof CliError)) return undefined;
  const reason = (err.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === "string" ? reason : undefined;
}

export interface CreateAppInput {
  slug: string;
  displayName: string;
  /** Optional plain-text summary; omitted from the body entirely when unset. */
  description?: string;
  visibility?: Visibility;
}

const VersionListSchema = z.array(VersionSchema);

/** Typed client for the portal REST API; responses are validated with the shared schemas. */
export class PortalClient {
  readonly #baseUrl: string;
  readonly #tokenProvider?: TokenProvider;
  #deploymentConfig?: Promise<DeploymentConfigResponse>;

  /** `token` may be a static string (dev token) or an async provider (OIDC). */
  constructor(baseUrl: string, token?: string | TokenProvider) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#tokenProvider = typeof token === "string" ? async () => token : token;
  }

  createApp(input: CreateAppInput): Promise<App> {
    return this.#json(AppSchema, "POST", "/api/v1/apps", {
      auth: true,
      body: {
        slug: input.slug,
        displayName: input.displayName,
        // Sent only when set, so a description-free create posts exactly the
        // body it always did — an older portal never sees a new key at all.
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      },
    });
  }

  /** Public IdP discovery info — how `helix login` finds the issuer. */
  getAuthConfig(): Promise<AuthConfigResponse> {
    return this.#json(AuthConfigResponseSchema, "GET", "/api/v1/auth/config", {});
  }

  /**
   * Public deployment topology (`GET /api/v1/config`), incl. the CI token
   * audience and the CLI version floor. Fetched once per client: the
   * compatibility check and the command that follows it share one request.
   */
  getDeploymentConfig(): Promise<DeploymentConfigResponse> {
    this.#deploymentConfig ??= this.#json(
      DeploymentConfigResponseSchema,
      "GET",
      "/api/v1/config",
      {},
    ).catch((err: unknown) => {
      this.#deploymentConfig = undefined;
      throw err;
    });
    return this.#deploymentConfig;
  }

  /** The app's GitHub binding (ADR-0051), or null when it has none. */
  async getRepoBinding(slug: string): Promise<RepoBinding | null> {
    try {
      return await this.#json(RepoBindingSchema, "GET", `/api/v1/apps/${enc(slug)}/repo-binding`, {
        auth: true,
      });
    } catch (err) {
      if (errorReason(err) === "no_binding") return null;
      throw err;
    }
  }

  putRepoBinding(slug: string, body: SetRepoBindingRequest): Promise<RepoBinding> {
    return this.#json(RepoBindingSchema, "PUT", `/api/v1/apps/${enc(slug)}/repo-binding`, {
      auth: true,
      body,
    });
  }

  async deleteRepoBinding(slug: string): Promise<void> {
    const res = await fetch(this.#url(`/api/v1/apps/${enc(slug)}/repo-binding`), {
      method: "DELETE",
      headers: await this.#authHeaders(true),
    });
    if (!res.ok) await this.#parse(z.unknown(), res);
  }

  /** The authenticated actor, per the portal — powers `helix whoami`. */
  me(): Promise<PortalMeResponse> {
    return this.#json(PortalMeResponseSchema, "GET", "/api/v1/me", { auth: true });
  }

  /**
   * The deployment-rendered agent skill (`GET /api/v1/skill`, ADR-0036) —
   * `text/markdown`, with this deployment's hosts filled in. Authed like every
   * other `/api/v1` read. Powers `helix skill`.
   */
  getSkill(): Promise<string> {
    return this.#text("/api/v1/skill", { auth: true });
  }

  /**
   * The deployment capability catalogue (`GET /api/v1/capabilities`), unparsed.
   * `helix capabilities` validates it when formatting, and falls back to the raw
   * JSON when a portal of a different version sends a shape this CLI doesn't know.
   */
  getCapabilities(): Promise<unknown> {
    return this.#json(z.unknown(), "GET", "/api/v1/capabilities", { auth: true });
  }

  listVersions(slug: string): Promise<Version[]> {
    // `auth: true` — portal reads are sign-in-gated too (ADR-0024); only
    // /health and the auth-config bootstrap are public.
    return this.#json(VersionListSchema, "GET", `/api/v1/apps/${enc(slug)}/versions`, {
      auth: true,
    });
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
      headers: await this.#authHeaders(true),
      body: form,
    });
    return this.#parse(UploadVersionResponseSchema, res);
  }

  /**
   * Upload from GitHub Actions to the CI route (ADR-0051), authenticated by the
   * job's GitHub OIDC token rather than a Helix sign-in.
   */
  async uploadCiVersion(
    slug: string,
    zip: Buffer,
    githubToken: string,
  ): Promise<UploadVersionResponse> {
    const form = new FormData();
    form.append("bundle", new Blob([new Uint8Array(zip)]), "bundle.zip");
    const res = await fetch(this.#url(`/api/v1/apps/${enc(slug)}/ci/versions`), {
      method: "POST",
      headers: { authorization: `Bearer ${githubToken}` },
      body: form,
    });
    return this.#parse(UploadVersionResponseSchema, res);
  }

  #url(path: string): string {
    return `${this.#baseUrl}${path}`;
  }

  async #authHeaders(auth: boolean): Promise<Record<string, string>> {
    if (!auth) return {};
    const token = await this.#tokenProvider?.();
    if (!token) {
      throw new CliError("not signed in; run `helix login` (or set HELIX_TOKEN / pass --token)");
    }
    return { authorization: `Bearer ${token}` };
  }

  async #json<T>(
    schema: z.ZodType<T>,
    method: string,
    path: string,
    opts: { auth?: boolean; body?: unknown },
  ): Promise<T> {
    const headers = await this.#authHeaders(opts.auth ?? false);
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
      throw errorFromResponse(res.status, data);
    }
    return schema.parse(data);
  }

  /** A non-JSON GET (the markdown skill) — errors still typed via the envelope. */
  async #text(path: string, opts: { auth?: boolean }): Promise<string> {
    const headers = await this.#authHeaders(opts.auth ?? false);
    const res = await fetch(this.#url(path), { method: "GET", headers });
    const body = await res.text();
    if (!res.ok) {
      const data: unknown = body ? safeJsonParse(body) : undefined;
      throw errorFromResponse(res.status, data);
    }
    return body;
  }
}

/**
 * Map a failed response onto a CliError. A 404 for a missing *route* (the
 * portal's not-found handler says `route … not found`, unlike "app not found")
 * almost always means the portal is older than this CLI, so it says so.
 */
function errorFromResponse(status: number, data: unknown): CliError {
  const parsed = ApiErrorSchema.safeParse(data);
  if (!parsed.success) return new CliError(`request failed (HTTP ${status})`);
  const { message, code, details } = parsed.data.error;
  if (status === 404 && code === "not_found" && message.startsWith("route ")) {
    return new CliError(
      `${message}. This portal is probably older than this CLI (${CLI_VERSION}); ` +
        "ask your operator to update Helix, or run an older @azx-pbc/helix-cli",
      code,
      details,
    );
  }
  return new CliError(message, code, details);
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/** JSON.parse that swallows the error — for probing an error body that may not be JSON. */
function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
