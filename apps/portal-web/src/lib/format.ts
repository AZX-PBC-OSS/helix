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
 * Whole days elapsed since an ISO timestamp. `timeAgo` renders age; this is the
 * numeric form the approvals queue thresholds its staleness tones on.
 */
export function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

/**
 * The last-resort rendering of an app-user principal, used when no directory
 * claims were captured for the row.
 *
 * Two of these are platform-minted sentinels rather than directory subjects, and
 * spelling them out beats making a reader recognise a prefix convention: `anon`
 * is a public-app visitor, who has no principal at all (there is no anonymous
 * identity in the system), and `pw_<random>` is a shared-password session — a
 * fresh pseudonym minted per login, so it is unattributable *across* sessions by
 * construction rather than by omission.
 *
 * Anything else is the raw subject. Under Entra that is a pairwise `sub`, which
 * names nobody; it is shown unchanged because it is at least stable enough to
 * correlate rows by, which is all it was ever good for.
 */
export function principalLabel(userOid: string): string {
  if (userOid === "anon") return "anonymous";
  if (userOid.startsWith("pw_")) return "shared password";
  return userOid;
}

// Deployment topology (apps base, dev-gateway base, spend cap) is NOT here: it
// used to be burned in from `import.meta.env` at build time, which meant the
// prebuilt bundle showed dev domains in every deployment. See lib/deployment.ts.
