/**
 * Per-tab bearer-token storage. sessionStorage is the deliberate tradeoff for
 * a first-party internal tool: survives reload, gone on tab close, never
 * shared cross-tab. No refresh token is ever stored — on expiry the user just
 * signs in again (full-page redirect, usually silent at the IdP).
 */

const KEY = "azx.portal.token";

interface StoredToken {
  token: string;
  /** Epoch ms; absent = no expiry hint from the IdP. */
  expiresAt?: number;
}

export function getToken(): string | null {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredToken;
    if (stored.expiresAt !== undefined && stored.expiresAt <= Date.now()) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return stored.token;
  } catch {
    sessionStorage.removeItem(KEY);
    return null;
  }
}

export function setToken(token: string, expiresInSeconds?: number): void {
  const stored: StoredToken = {
    token,
    ...(expiresInSeconds !== undefined ? { expiresAt: Date.now() + expiresInSeconds * 1000 } : {}),
  };
  sessionStorage.setItem(KEY, JSON.stringify(stored));
}

export function clearToken(): void {
  sessionStorage.removeItem(KEY);
}
