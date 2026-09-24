import type { PrincipalKind } from "@azx-pbc/shared";

/** Small display formatters shared across pages. */

/** 14200 → "14.2k", 1340000 → "1.34M". */
export function fmtCount(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

/**
 * USD spend → "$0.00" / "$12.40" / "$1.3k". Small spends keep cents so a few
 * calls don't read as "$0"; large totals abbreviate. `<$0.01` for tiny non-zero.
 */
export function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

/**
 * ISO timestamp → "2h ago" / "3d ago" / "just now". Stays relative at every age:
 * this used to fall back to a bare `toLocaleDateString()` past 30 days, which
 * dropped the staleness signal exactly where it matters most (a 45-day-old
 * approval read as "7/1/2026" — a date, not a backlog).
 */
export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * The future-facing mirror of {@link timeAgo}: "in 2m" / "in 3h" / "now".
 * Session expiries and refresh-due times are instants ahead of the reader, and
 * rendering them with `timeAgo`'s floor at zero would show a session that dies
 * in 90 seconds as "just now" — true, and useless on a kill screen where the
 * countdown is the whole point.
 */
export function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const s = Math.floor(ms / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

/**
 * Whole days elapsed since an ISO timestamp. `timeAgo` renders age; this is the
 * numeric form the approvals queue thresholds its staleness tones on.
 */
export function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

/**
 * Fallback labels when no user name or email was captured.
 * Use recorded userKind to distinguish public visitors and password sessions.
 * Do not infer kind from a pw_ prefix: a real principal id can share that prefix.
 * Password pseudonyms identify one login session, not a person across sessions.
 *
 * The exact anon sentinel also labels legacy rows. Other rows without userKind
 * retain the raw principal id rather than guessing an attribution.
 */
export function principalLabel(userOid: string, userKind?: PrincipalKind | null): string {
  if (userKind === "anon" || userOid === "anon") return "anonymous";
  if (userKind === "password") return "shared password";
  return userOid;
}

// Deployment topology (apps base, dev-gateway base, spend cap) is NOT here: it
// used to be burned in from `import.meta.env` at build time, which meant the
// prebuilt bundle showed dev domains in every deployment. See lib/deployment.ts.
