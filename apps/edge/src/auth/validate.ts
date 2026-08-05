import type { FastifyRequest } from "fastify";
import { SLUG_PATTERN } from "@azx-pbc/shared";
import { publicOrigin, type EdgeConfig } from "../config.js";
import type { RegistryEntry, RegistryReader } from "../registry/projection.js";

/**
 * Parameter validation for the auth host (architecture Appendix A.1 step 2):
 * `rd` validation is what stops `/start` being an open redirector, and the
 * `app` lookup is what stops handoffs being minted for hosts we don't serve.
 */

const MAX_RD_LENGTH = 2000;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\x00-\x20\x7f]/;

/**
 * A return path is acceptable only if it is a same-origin absolute path:
 * starts with exactly one `/`, no scheme, no authority, no control chars,
 * and survives URL resolution without changing origin. Null = reject.
 */
export function validateReturnPath(rd: string | undefined): string | null {
  if (rd === undefined || rd === "") return "/";
  if (rd.length > MAX_RD_LENGTH) return null;
  if (CONTROL_OR_SPACE.test(rd)) return null;
  // `//host`, `/\host` and `\…` are network-path / IE-style absolute URLs.
  if (!rd.startsWith("/") || rd.startsWith("//") || rd.startsWith("/\\")) return null;

  // Round-trip: resolved against a known origin, it must stay on that origin
  // and remain path-only (catches encodings the prefix checks miss).
  let resolved: URL;
  try {
    resolved = new URL(rd, "https://rd-probe.invalid");
  } catch {
    return null;
  }
  if (resolved.origin !== "https://rd-probe.invalid") return null;
  return rd;
}

export type AppForAuth =
  | { kind: "ok"; entry: RegistryEntry }
  | { kind: "unknown" }
  | { kind: "registry-unavailable" }
  /** `public` visibility — no session is ever minted, so SSO has nothing to do. */
  | { kind: "unsupported-mode" };

/** Resolve and vet the `app` parameter / host slug for the login flow. */
export function resolveAppForAuth(registry: RegistryReader, slug: string | undefined): AppForAuth {
  if (!registry.isLoaded()) return { kind: "registry-unavailable" };
  if (!slug || !SLUG_PATTERN.test(slug)) return { kind: "unknown" };
  const entry = registry.getApp(slug);
  // Archived apps answer like unknown ones here — no session minting, and no
  // distinguishing the two through the auth host.
  if (!entry || entry.archived) return { kind: "unknown" };
  // SSO serves private, group, AND password apps: a `password` app is "the
  // shared password OR any SSO user" (the password login UI links here). Only
  // `public` has no session at all, so it can't use the OIDC flow.
  if (entry.visibilityMode === "public") {
    return { kind: "unsupported-mode" };
  }
  return { kind: "ok", entry };
}

/**
 * Cross-app CSRF guard for state-changing requests on app hosts (architecture
 * §4.2): the `Origin` header must exactly match the app's own public origin.
 * `SameSite` does not protect one app's `/_api/*` from a sibling subdomain's
 * form/fetch POST riding the user's session, so the gateway and logout require
 * a matching Origin. A missing Origin fails closed.
 */
export function isSameOrigin(
  originHeader: string | string[] | undefined,
  config: EdgeConfig,
  slug: string,
): boolean {
  return typeof originHeader === "string" && originHeader === publicOrigin(config, slug);
}

/**
 * `Sec-Fetch-Site`, where the browser sent one, as a same-origin verdict.
 * Returns `undefined` when the header is absent so the caller can fall back.
 *
 * Fetch Metadata is the right signal for a CSRF guard that must also cover
 * **GET**: it rides every request from every current browser, whereas `Origin`
 * is appended only for CORS-tainted requests or non-GET/HEAD methods. It is also
 * a forbidden header name, so page script cannot set or spoof it, and it
 * distinguishes `same-site` (a sibling subdomain — the exact threat the Origin
 * check exists for, and the one `SameSite` cookies do not cover) from
 * `same-origin`.
 *
 * `none` is a user-initiated request (address bar, bookmark) — not attacker
 * reachable, so it is accepted, matching {@link isSameOriginFormPost}.
 */
function fetchMetadataSameOrigin(secFetchSite: string | string[] | undefined): boolean | undefined {
  if (typeof secFetchSite !== "string" || secFetchSite === "") return undefined;
  return secFetchSite === "same-origin" || secFetchSite === "none";
}

/**
 * The gateway's CSRF seam (dev-mode §5.4). The `/_api/*` handlers call this to
 * decide whether a request's Origin is allowed. On the edge it is the
 * same-origin check below; the dev-gateway swaps in an allowlist check (the
 * `DevTokenResolver` has already matched the Origin against the token's
 * registered origins, so its `checkOrigin` returns true). Injected into the
 * handler runtimes alongside `resolveCaller`.
 */
export type OriginCheck = (req: FastifyRequest, entry: RegistryEntry) => boolean;

/**
 * The production origin check for `/_api/*`.
 *
 * `Sec-Fetch-Site` is authoritative when present; otherwise the `Origin` must
 * match exactly, and an absent one still fails closed.
 *
 * The two-signal form is required, not belt-and-braces. This seam guards **GET**
 * as well as mutations — `/_api/fetch/*` spends a connection credential and
 * returns third-party data on a GET, so a cross-origin GET riding the victim's
 * session is a real exfiltration path and cannot be exempted the way
 * `data-handler`'s reads are. But a same-origin `fetch()` GET carries **no**
 * `Origin` header at all, so an Origin-only check rejected every legitimate
 * browser read through the proxy. Fetch Metadata is the signal that covers both.
 *
 * Note a non-browser client (curl) sends neither header and is still refused;
 * one that sets `Sec-Fetch-Site: same-origin` by hand is not a CSRF vector — it
 * already holds the session cookie, which is the thing CSRF exists to exploit
 * *without* holding.
 */
export function makeSameOriginCheck(config: EdgeConfig): OriginCheck {
  return (req, entry) =>
    fetchMetadataSameOrigin(req.headers["sec-fetch-site"]) ??
    isSameOrigin(req.headers.origin, config, entry.slug);
}

/**
 * CSRF guard for a top-level **form POST** (the shared-password login). Unlike
 * the fetch()-driven mutations above — which always carry `Origin`, so
 * {@link isSameOrigin}'s missing-fails-closed posture is right — a same-origin
 * HTML form navigation legitimately *omits* `Origin` in several browsers
 * (Firefox, Safari, some Chrome configs). So:
 *
 *  - `Sec-Fetch-Site`, where present, is authoritative (all current browsers):
 *    accept `same-origin`/`none`, reject `same-site` (sibling subdomain) and
 *    `cross-site`.
 *  - Otherwise (older browsers): a *present* `Origin` must match; an *absent*
 *    one is necessarily same-origin — a cross-origin POST always sends `Origin`,
 *    which an attacker cannot strip — so it is accepted.
 */
export function isSameOriginFormPost(
  originHeader: string | string[] | undefined,
  secFetchSite: string | string[] | undefined,
  config: EdgeConfig,
  slug: string,
): boolean {
  if (typeof secFetchSite === "string" && secFetchSite !== "") {
    return secFetchSite === "same-origin" || secFetchSite === "none";
  }
  if (originHeader === undefined) return true;
  return isSameOrigin(originHeader, config, slug);
}

/**
 * Whether this deployment permits an app in the given visibility mode at all.
 * `public` and `password` are open-to-the-internet surfaces an operator can
 * forbid per deployment (`EDGE_ALLOW_*_APPS`); `private`/`group` are SSO-gated
 * and always permitted. This is an operator policy check, distinct from the
 * per-session {@link visibilityAllows} authorization check below.
 */
export function visibilityModeAllowed(
  mode: RegistryEntry["visibilityMode"],
  config: EdgeConfig,
): boolean {
  if (mode === "public") return config.allowPublicApps;
  if (mode === "password") return config.allowPasswordApps;
  return true;
}

/** Does this session's group snapshot satisfy the app's visibility rule? */
export function visibilityAllows(entry: RegistryEntry, groups: string[]): boolean {
  if (entry.visibilityMode === "private") return true;
  if (entry.visibilityMode === "group") {
    return entry.visibilityGroupId !== null && groups.includes(entry.visibilityGroupId);
  }
  // A `password` session is itself proof of the password — it could only have
  // been minted by the /_auth/login challenge (passwordLogin.ts). The OIDC
  // callback never resolves password apps, so this branch is gate-only.
  if (entry.visibilityMode === "password") return true;
  return false; // public never passes the session gate
}
