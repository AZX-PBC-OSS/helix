import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PortalMeResponse } from "@azx-pbc/shared";
import { PortalApiError } from "../api/client";
import { authConfigQuery, meQuery } from "../api/queries";
import { beginLogin } from "./oidc";
import { clearToken, getToken, setToken } from "./tokenStore";

/**
 * Auth state for the SPA. The portal API now requires sign-in for every read,
 * so the whole UI sits behind a sign-in gate (`RequireAuth`); admin areas sit
 * behind an additional `platform-admin` check (`RequireAdmin`). `me` comes from
 * /api/v1/me once a token is present and carries the server-computed `isAdmin`.
 */

export interface AuthState {
  /** Bearer token present (the app renders below the sign-in gate). */
  authenticated: boolean;
  /** The verified actor, once /api/v1/me responds. */
  me: PortalMeResponse | undefined;
  /** Server-computed: the actor holds the `platform-admin` role. */
  isAdmin: boolean;
  /**
   * Server-computed: this caller may run a tenant-wide group search
   * (`PORTAL_DIRECTORY_SEARCH`, ADR-0040 decision 11). Lets `GroupPicker` avoid
   * issuing a search it would only be refused, rather than firing one and
   * interpreting the 403 — which matters because a refused search is **not** a
   * broken directory, and must not be rendered as one.
   *
   * **Tri-state, and `undefined` is load-bearing: it means we do not know.** This
   * was a plain boolean defaulting to `false`, justified on "while /api/v1/me is
   * in flight" — and `RequireAuth` does hold the tree behind a loader for that.
   * But `meLoading` is `me.isLoading`, which goes false the moment the query
   * *errors* with anything other than a 401, and `meQuery` sets `retry: false` —
   * so a single 500 or one network blip rendered the app with no `me` at all, and
   * the picker turned that into "search is limited to platform admins on this
   * deployment": a confident statement of deployment policy, false on a default
   * deployment, caused by a transient portal fault with nothing on screen to
   * connect it to.
   *
   * So the unknown case is now representable, and the picker shows no search box
   * **and no claim** for it. `isAdmin` degrades the same way and is left alone —
   * hiding a nav item asserts nothing.
   */
  canSearchDirectory: boolean | undefined;
  /**
   * Why search was refused, when it was. Absent when the caller may search, and
   * when `me` has not answered. Drives which sentence the picker shows — "ask a
   * platform admin" is good advice under the `admins` tier and actively
   * misleading under `none`.
   */
  searchRestriction: PortalMeResponse["searchRestriction"];
  /** A token is present but /api/v1/me hasn't resolved yet (guards show a loader). */
  meLoading: boolean;
  /** Whether the portal has an IdP configured (login possible at all). */
  loginAvailable: boolean;
  /**
   * Deployment visibility policy (from /auth/config). Drives which open-surface
   * modes the visibility UI offers. Default false when config is absent (older
   * portal / dev-token-only) — open surfaces are opt-in, and server-side
   * enforcement is the real guard.
   */
  allowPublicApps: boolean;
  allowPasswordApps: boolean;
  login: () => void;
  /** Called by the OIDC callback page with a fresh token. */
  adoptToken: (token: string, expiresIn?: number) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [hasToken, setHasToken] = useState(() => getToken() !== null);

  const authConfig = useQuery(authConfigQuery);
  const me = useQuery({ ...meQuery, enabled: hasToken });

  const login = useCallback(() => {
    if (!authConfig.data) return;
    void beginLogin(authConfig.data, window.location.pathname);
  }, [authConfig.data]);

  const adoptToken = useCallback(
    (token: string, expiresIn?: number) => {
      setToken(token, expiresIn);
      setHasToken(true);
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    [queryClient],
  );

  const logout = useCallback(() => {
    clearToken();
    setHasToken(false);
    queryClient.removeQueries({ queryKey: ["me"] });
  }, [queryClient]);

  // A stale or invalid token surfaces as a 401 on /api/v1/me. Treat it as
  // logged-out (so the UI falls back to the sign-in gate rather than rendering a
  // broken shell whose every request 401s) and purge it from storage so a reload
  // starts clean.
  const tokenRejected = me.error instanceof PortalApiError && me.error.status === 401;
  useEffect(() => {
    if (tokenRejected) clearToken();
  }, [tokenRejected]);

  const authenticated = hasToken && !tokenRejected;

  const value = useMemo<AuthState>(
    () => ({
      authenticated,
      me: me.data,
      isAdmin: me.data?.isAdmin ?? false,
      // No `?? false`: see the tri-state note on the field.
      canSearchDirectory: me.data?.canSearchDirectory,
      searchRestriction: me.data?.searchRestriction,
      meLoading: authenticated && me.isLoading,
      loginAvailable: authConfig.isSuccess && Boolean(authConfig.data.webClientId),
      allowPublicApps: authConfig.data?.allowPublicApps ?? false,
      allowPasswordApps: authConfig.data?.allowPasswordApps ?? false,
      login,
      adoptToken,
      logout,
    }),
    [
      authenticated,
      me.data,
      me.isLoading,
      authConfig.isSuccess,
      authConfig.data,
      login,
      adoptToken,
      logout,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
