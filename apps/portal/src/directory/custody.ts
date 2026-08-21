import { DefaultAzureCredential } from "@azure/identity";
import {
  createDirectory,
  GRAPH_SCOPE,
  type DirectoryProvider,
  type GetGraphToken,
} from "@azx-pbc/directory";

/**
 * Bearer tokens for Microsoft Graph, via `@azure/identity` — the exact shape
 * `defaultAzureVaultToken` uses for Key Vault (`../secrets/custody.ts`), and for
 * the same reason: the portal is the privileged control plane and already
 * depends on `@azure/identity`, so ADR-0027's line ("acceptable on the
 * privileged control plane, never the edge") is already paid for here.
 *
 * In the deployed platform this resolves to the user-assigned managed identity
 * that holds the `GroupMember.Read.All` app-role assignment (ADR-0040 decision
 * 4): it already exists, has nothing to rotate, and sidesteps the tenant policy
 * that bans client secrets.
 *
 * **On a developer machine it resolves to `az login` instead, and that is a
 * different kind of token.** `DefaultAzureCredential` falls through to
 * `AzureCliCredential`, which yields a **delegated (user) token** — so what you
 * can read depends on the signed-in user's own directory rights, not on the
 * app-role grant. A directory admin will get results; an ordinary user may get
 * `403 Authorization_RequestDenied` on `/groups?$search=`, which the provider
 * reports as `no-consent` and the Access tab renders as a banner. Set
 * `AZURE_TENANT_ID` if your `az login` spans several tenants.
 */
export function defaultAzureGraphToken(): GetGraphToken {
  const credential = new DefaultAzureCredential();
  return async () => {
    const token = await credential.getToken(GRAPH_SCOPE);
    if (!token) throw new Error("could not acquire a Microsoft Graph token");
    return token.token;
  };
}

/** What {@link createDirectoryFromEnv} chose, and why — for the boot log. */
export interface DirectoryChoice {
  provider: DirectoryProvider;
  /** One line naming the backend and the env that selected it. */
  detail: string;
}

/**
 * Build the directory provider from the environment (ADR-0040 decision 3).
 *
 * **`PORTAL_DIRECTORY` is the explicit selector and always wins:**
 *
 * - `entra` — Microsoft Graph, via `DefaultAzureCredential`. This is how you use
 *   a real tenant from a dev machine (`az login` first). Without it there was no
 *   way to ask for real Entra locally at all, because the auto-detection below
 *   keys on a variable only Container Apps sets — so a developer pointing the
 *   portal at real Entra for *auth* still silently got fixture groups for
 *   *search*, and a picker full of groups that do not exist in their tenant.
 * - `fixtures` — the in-memory dev set. Refused in production.
 * - `off` — report unavailable; the Access tab falls back to entering ids
 *   directly, which is also the permanent answer for a tenant that declines the
 *   Graph permission (decision 8).
 *
 * With it unset, the fallback is auto-detection: `AZURE_CLIENT_ID` (present only
 * under a managed identity, i.e. the deployed platform) selects Entra; otherwise
 * fixtures outside production, and unavailable in it.
 *
 * **Fixtures are refused in production**, the same idiom as
 * `createDevTokenVerifier` and the `PORTAL_OIDC_ALLOW_INSECURE` guard: a prod
 * portal answering searches from a hardcoded list would show an operator groups
 * that do not exist in their tenant and let them scope an app to an id nobody
 * holds — an app that then denies everyone, looking like a platform bug rather
 * than a configuration one.
 *
 * Returns the reason for its choice rather than just the provider, because a
 * directory that silently answers from the wrong backend is the failure this
 * function has already caused once, and a boot log is what makes it a five-second
 * diagnosis instead of an afternoon.
 *
 * Takes `env` as a parameter, never reading ambient `process.env`, so all of the
 * above is testable.
 */
export function createDirectoryFromEnv(env: NodeJS.ProcessEnv = process.env): DirectoryChoice {
  const isProduction = env.NODE_ENV === "production";
  const requested = env.PORTAL_DIRECTORY;

  if (requested === "entra") {
    return {
      provider: createDirectory({ getToken: defaultAzureGraphToken() }),
      detail: "Microsoft Graph (PORTAL_DIRECTORY=entra)",
    };
  }
  if (requested === "off") {
    return {
      provider: createDirectory({}),
      detail: "unavailable (PORTAL_DIRECTORY=off) — group ids can still be entered by hand",
    };
  }
  if (requested === "fixtures") {
    if (isProduction) {
      // Explicitly asked for, explicitly refused: this is the one request that
      // would put fake groups in front of a real operator.
      return {
        provider: createDirectory({}),
        detail:
          "unavailable — PORTAL_DIRECTORY=fixtures is refused in production; " +
          "set PORTAL_DIRECTORY=entra or leave it unset",
      };
    }
    return {
      provider: createDirectory({ allowFixtures: true }),
      detail: "dev fixtures (PORTAL_DIRECTORY=fixtures) — NOT your real directory",
    };
  }
  if (requested !== undefined) {
    // A typo must not silently become fixtures.
    return {
      provider: createDirectory({}),
      detail: `unavailable — PORTAL_DIRECTORY="${requested}" is not one of entra|fixtures|off`,
    };
  }

  if (env.AZURE_CLIENT_ID) {
    return {
      provider: createDirectory({ getToken: defaultAzureGraphToken() }),
      detail: "Microsoft Graph (managed identity via AZURE_CLIENT_ID)",
    };
  }
  if (!isProduction) {
    return {
      provider: createDirectory({ allowFixtures: true }),
      detail:
        "dev fixtures (no AZURE_CLIENT_ID) — NOT your real directory; " +
        "set PORTAL_DIRECTORY=entra and run `az login` to search a real tenant",
    };
  }
  return {
    provider: createDirectory({}),
    detail: "unavailable (no AZURE_CLIENT_ID in production) — group ids can be entered by hand",
  };
}
