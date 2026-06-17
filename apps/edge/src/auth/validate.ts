import { SLUG_PATTERN } from "@helix/shared";
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
