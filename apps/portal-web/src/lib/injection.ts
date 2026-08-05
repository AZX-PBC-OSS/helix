import type { InjectionRecipe } from "@azx-pbc/shared";

/**
 * Injection-recipe form logic, shared by the two secret-creation surfaces: the
 * global/platform admin page (`pages/admin/SecretsPage.tsx`) and the app-scoped
 * card on the Capabilities tab (`pages/tabs/SecretsCard.tsx`).
 *
 * These were duplicated verbatim in both files and had already drifted. They live
 * here so a new recipe kind is a one-place change; the forms themselves stay
 * separate (they differ in scope, tier, and layout).
 */

/** Field values a recipe form collects — a superset across all kinds. */
export interface InjectionFormState {
  headerName: string;
  queryParam: string;
  timestampHeader: string;
  template: string;
}

export const EMPTY_INJECTION_FORM: InjectionFormState = {
  headerName: "",
  queryParam: "",
  timestampHeader: "",
  template: "",
};

/** Placeholders, also used as the fallback when a field is left blank. */
export const INJECTION_DEFAULTS = {
  headerName: "x-api-key",
  queryParam: "api_key",
  timestampHeader: "x-date",
  template: "Credential={credential},Signature={signature}",
} as const;

/** Human labels for the recipe select, which is driven by `INJECTION_KINDS`. */
export const INJECTION_LABELS: Record<string, string> = {
  "header-bearer": "Bearer token",
  header: "Custom header",
  query: "Query parameter",
  "hmac-timestamp": "HMAC over timestamp",
};

/** Build a recipe from the form state, falling back to the placeholder values. */
export function buildInjection(kind: string, form: InjectionFormState): InjectionRecipe {
  switch (kind) {
    case "header":
      return {
        kind: "header",
        name: form.headerName || INJECTION_DEFAULTS.headerName,
        template: "{}",
      };
    case "query":
      return { kind: "query", param: form.queryParam || INJECTION_DEFAULTS.queryParam };
    case "hmac-timestamp":
      return {
        kind: "hmac-timestamp",
        timestampHeader: form.timestampHeader || INJECTION_DEFAULTS.timestampHeader,
        authHeader: "authorization",
        template: form.template || INJECTION_DEFAULTS.template,
      };
    default:
      return { kind: "header-bearer" };
  }
}

/**
 * One-line description for a secret's badge.
 *
 * A `switch` with an annotated return rather than an if-chain: an unhandled kind
 * then fails typecheck ("function lacks ending return statement") instead of
 * falling through to another kind's branch and rendering nonsense.
 */
export function describeInjection(r: InjectionRecipe): string {
  switch (r.kind) {
    case "header-bearer":
      return "Authorization: Bearer …";
    case "header":
      return `${r.name}: ${r.template}`;
    case "query":
      return `?${r.param}=…`;
    case "hmac-timestamp":
      return `${r.authHeader}: HMAC-SHA256 over ${r.timestampHeader}`;
  }
}

/**
 * `hmac-timestamp` stores both halves of the key pair in the one sealed value, so
 * a regenerated pair rotates atomically. The form collects them separately and
 * packs them here — nobody should be hand-typing JSON into a password box.
 */
export function packHmacValue(credential: string, key: string): string {
  return JSON.stringify({ credential, key });
}

/** Whether the value field should collect a credential pair rather than one secret. */
export function usesCredentialPair(kind: string): boolean {
  return kind === "hmac-timestamp";
}
