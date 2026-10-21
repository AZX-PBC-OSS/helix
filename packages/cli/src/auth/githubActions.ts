import { z } from "zod";
import { CliError } from "../client.js";

/**
 * GitHub Actions OIDC for `helix deploy` in CI (ADR-0051 decision 9). A job
 * with `permissions: id-token: write` gets two env vars; with them the CLI asks
 * GitHub for a short-lived token whose audience is this portal, and uploads to
 * the CI route with it. Nothing is stored in the repo.
 */

export interface GithubTokenSource {
  requestUrl: string;
  requestToken: string;
}

/** The job's token endpoint, or null when not running with `id-token: write`. */
export function githubTokenSource(env: NodeJS.ProcessEnv): GithubTokenSource | null {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  return requestUrl && requestToken ? { requestUrl, requestToken } : null;
}

const IdTokenResponseSchema = z.object({ value: z.string().min(1) });

/** Request an ID token for `audience`. The audience is set as a query parameter. */
export async function requestGithubIdToken(
  source: GithubTokenSource,
  audience: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = new URL(source.requestUrl);
  url.searchParams.set("audience", audience);
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${source.requestToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    throw new CliError(`GitHub refused the ID token request (HTTP ${res.status})`);
  }
  const parsed = IdTokenResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new CliError("GitHub's ID token response had no token");
  return parsed.data.value;
}
