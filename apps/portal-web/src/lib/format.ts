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

/** ISO timestamp → "2h ago" / "3d ago" / "just now". */
export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Where apps are served, as reachable by this browser (architecture §4.1).
 * Carries scheme + host + port of the edge; the slug is prepended.
 */
const APP_PUBLIC_BASE = new URL(
  (import.meta.env.VITE_APP_PUBLIC_BASE as string | undefined) ??
    "https://local.helix.azxlabs.io:8080",
);

export function appHost(slug: string): string {
  return `${slug}.${APP_PUBLIC_BASE.host}`;
}

export function appUrl(slug: string): string {
  return `${APP_PUBLIC_BASE.protocol}//${appHost(slug)}`;
}
