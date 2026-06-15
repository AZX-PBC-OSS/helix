import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PortalMeResponse } from "@helix/shared";
import { authConfigQuery, meQuery } from "../api/queries";
import { beginLogin } from "./oidc";
import { clearToken, getToken, setToken } from "./tokenStore";

/**
 * Auth state for the SPA. Reads are open on the portal API, so the whole UI
 * renders logged out; a token only gates mutations. `me` comes from
 * /api/v1/me once a token is present.
 */

export interface AuthState {
  /** Bearer token present (mutations will be attempted). */
  authenticated: boolean;
  /** The verified actor, once /api/v1/me responds. */
  me: PortalMeResponse | undefined;
  /** Whether the portal has an IdP configured (login possible at all). */
  loginAvailable: boolean;
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

  const value = useMemo<AuthState>(
    () => ({
      authenticated: hasToken,
      me: me.data,
      loginAvailable: authConfig.isSuccess && Boolean(authConfig.data.webClientId),
      login,
      adoptToken,
      logout,
    }),
    [hasToken, me.data, authConfig.isSuccess, authConfig.data, login, adoptToken, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
