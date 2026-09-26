import {
  ApiOriginsSchema,
  HeaderNameSchema,
  OAuthEndpointSchema,
  ProviderDisplayNameSchema,
  ProviderRefSchema,
  RequestedScopesSchema,
  ScopeTokenSchema,
  type ProviderMetadata,
  type ProviderCreateRequest,
  type ProviderUpdateRequest,
  type SensitiveProviderField,
  type TokenPlacement,
} from "@azx-pbc/shared";

/**
 * The provider form's logic (I-02 T-0026): the field contract design.md
 * §Provider create/edit fixes, expressed against the SAME shared schemas the
 * server's 422s come from — a restated rule would drift and the inline errors
 * would stop mirroring the rejection. Pure functions, no React; the import UI
 * (T-0027) reuses the validation and the placement description.
 */

/** The form's values as the fields hold them — raw input, trimmed only at the edges. */
export interface ProviderFormValues {
  ref: string;
  displayName: string;
  /** Create-only; `""` = not chosen yet (the admin chooses explicitly, every time). */
  env: "" | "dev" | "prod";
  authorizeEndpoint: string;
  tokenEndpoint: string;
  /** Edit semantics: blank keeps the stored credential; a value is a new identity/rotation. */
  clientId: string;
  clientSecret: string;
  requestedScopes: string[];
  apiOrigins: string[];
  placementKind: TokenPlacement["kind"];
  headerName: string;
}

export const EMPTY_PROVIDER_FORM: ProviderFormValues = {
  ref: "",
  displayName: "",
  env: "",
  authorizeEndpoint: "",
  tokenEndpoint: "",
  clientId: "",
  clientSecret: "",
  requestedScopes: [],
  apiOrigins: [],
  placementKind: "header-bearer",
  headerName: "",
};

/** Seed the form from a provider's metadata (the edit route's reseed source). */
export function formValuesFromMetadata(m: ProviderMetadata): ProviderFormValues {
  return {
    ...EMPTY_PROVIDER_FORM,
    ref: m.ref,
    displayName: m.displayName,
    env: m.env,
    authorizeEndpoint: m.authorizeEndpoint,
    tokenEndpoint: m.tokenEndpoint,
    requestedScopes: [...m.requestedScopes],
    apiOrigins: [...m.apiOrigins],
    placementKind: m.tokenPlacement.kind,
    headerName: m.tokenPlacement.kind === "header" ? m.tokenPlacement.name : "",
  };
}

export const PROVIDER_FIELD_LABELS: Record<string, string> = {
  ref: "Reference",
  displayName: "Display name",
  env: "Environment",
  authorizeEndpoint: "Authorize endpoint",
  tokenEndpoint: "Token endpoint",
  clientId: "Client ID",
  clientSecret: "Client secret",
  requestedScopes: "Requested permissions",
  apiOrigins: "API destinations",
  tokenPlacement: "Token placement",
  headerName: "Header name",
};

export function describeTokenPlacement(p: TokenPlacement): string {
  return p.kind === "header-bearer" ? "Authorization: Bearer header" : `Header: ${p.name}`;
}

/** The placement value the validated form builds (query-string and signing recipes are not offered). */
export function placementFromForm(values: ProviderFormValues): TokenPlacement {
  return values.placementKind === "header"
    ? { kind: "header", name: values.headerName.trim() }
    : { kind: "header-bearer" };
}

const firstIssue = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? undefined : (result.error?.issues[0]?.message ?? "invalid value");

/**
 * Field-level validation mirroring the server's 422s — each rule IS the shared
 * schema's rule. Returns a message per field key; absent = valid. Element-level
 * rules are checked per tag so the error can name the offending value's rule.
 */
export function fieldErrors(
  values: ProviderFormValues,
  mode: "create" | "edit",
): Partial<Record<keyof ProviderFormValues, string>> {
  const errors: Partial<Record<keyof ProviderFormValues, string>> = {};

  if (mode === "create") {
    if (!values.ref.trim()) errors.ref = "a reference is required";
    else errors.ref = firstIssue(ProviderRefSchema.safeParse(values.ref.trim()));
    if (!values.env) errors.env = "choose an environment — a provider never moves between them";
  }
  errors.displayName = firstIssue(ProviderDisplayNameSchema.safeParse(values.displayName.trim()));
  errors.authorizeEndpoint = firstIssue(
    OAuthEndpointSchema.safeParse(values.authorizeEndpoint.trim()),
  );
  errors.tokenEndpoint = firstIssue(OAuthEndpointSchema.safeParse(values.tokenEndpoint.trim()));

  // Per-tag first, so a bad value names its own rule; then the list rules. The
  // list parse canonicalizes (ApiOriginSchema transforms), so it only runs once
  // every element parsed — canonicalOrigins throws on an invalid element.
  errors.requestedScopes =
    values.requestedScopes
      .map((scope) => firstIssue(ScopeTokenSchema.safeParse(scope)))
      .find(Boolean) ?? firstIssue(RequestedScopesSchema.safeParse(values.requestedScopes));
  errors.apiOrigins = validateOrigins(values.apiOrigins);

  if (values.placementKind === "header") {
    errors.headerName = firstIssue(HeaderNameSchema.safeParse(values.headerName.trim()));
  }
  if (mode === "create") {
    if (!values.clientId) errors.clientId = "a client ID is required";
    if (!values.clientSecret) errors.clientSecret = "a client secret is required";
  }
  return errors;
}

/** True when no field carries a message — the Save gate's validation half. */
export function isFormValid(errors: Partial<Record<keyof ProviderFormValues, string>>): boolean {
  return Object.values(errors).every((message) => message === undefined);
}

/** The origins as the stored row carries them — canonical, so comparisons and bodies agree with the server. */
export function canonicalOrigins(origins: string[]): string[] {
  return origins.map((origin) => ApiOriginsSchema.element.parse(origin.trim()));
}

/** Element errors first; the bounded/duplicate/min-1 rules run on the canonicalized list only. */
function validateOrigins(origins: string[]): string | undefined {
  const elementError = origins
    .map((origin) => firstIssue(ApiOriginsSchema.element.safeParse(origin)))
    .find(Boolean);
  if (elementError !== undefined) return elementError;
  return firstIssue(ApiOriginsSchema.safeParse(canonicalOrigins(origins)));
}

const setEqual = (a: string[], b: string[]) =>
  [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * The sensitive fields the edit would change — the client half of the single
 * `SENSITIVE_PROVIDER_FIELDS` comparison (the server re-runs it on the parsed
 * request; the two can disagree only if the stored row changed since the seed,
 * which is what the 409 `confirmation_required` panel flow answers).
 * `clientId` is presence-detected: supplying one IS the change signal.
 */
export function sensitiveDeltaFromForm(
  seed: ProviderMetadata,
  values: ProviderFormValues,
): SensitiveProviderField[] {
  const delta: SensitiveProviderField[] = [];
  if (values.clientId.trim() !== "") delta.push("clientId");
  if (seed.authorizeEndpoint !== values.authorizeEndpoint.trim()) delta.push("authorizeEndpoint");
  if (seed.tokenEndpoint !== values.tokenEndpoint.trim()) delta.push("tokenEndpoint");
  if (!setEqual(seed.requestedScopes, values.requestedScopes)) delta.push("requestedScopes");
  if (!setEqual(seed.apiOrigins, canonicalOrigins(values.apiOrigins))) delta.push("apiOrigins");
  if (JSON.stringify(seed.tokenPlacement) !== JSON.stringify(placementFromForm(values))) {
    delta.push("tokenPlacement");
  }
  return delta;
}

/** The create request body — credentials required, env explicit, origins canonical. */
export function buildCreateBody(values: ProviderFormValues): ProviderCreateRequest {
  return {
    ref: values.ref.trim(),
    displayName: values.displayName.trim(),
    // The one kind this deployment serves (PROVIDER_KINDS); the create schema
    // defaults it — the type carries it because a stored row is always complete.
    kind: "rest-delegated",
    env: values.env as ProviderCreateRequest["env"],
    authorizeEndpoint: values.authorizeEndpoint.trim(),
    tokenEndpoint: values.tokenEndpoint.trim(),
    clientId: values.clientId,
    clientSecret: values.clientSecret,
    requestedScopes: values.requestedScopes,
    apiOrigins: canonicalOrigins(values.apiOrigins),
    tokenPlacement: placementFromForm(values),
  };
}

/**
 * The edit request body — full-replace editable fields, absent credentials
 * mean keep (blank is the only way the form says "unchanged"), revision is the
 * seeded row's optimistic-lock input.
 */
export function buildUpdateBody(
  seed: ProviderMetadata,
  values: ProviderFormValues,
): ProviderUpdateRequest {
  return {
    displayName: values.displayName.trim(),
    authorizeEndpoint: values.authorizeEndpoint.trim(),
    tokenEndpoint: values.tokenEndpoint.trim(),
    requestedScopes: values.requestedScopes,
    apiOrigins: canonicalOrigins(values.apiOrigins),
    tokenPlacement: placementFromForm(values),
    revision: seed.revision,
    ...(values.clientId.trim() !== "" ? { clientId: values.clientId.trim() } : {}),
    ...(values.clientSecret !== "" ? { clientSecret: values.clientSecret } : {}),
  };
}

/** One line of the review panel's field diff: current → proposed. */
export interface ProviderDiffLine {
  field: string;
  label: string;
  current: string;
  proposed: string;
}

/**
 * The review panel's diff — one line per changed field, computed from the
 * seeded metadata against the draft. `clientId`'s stored half is sealed and
 * never readable, so its "current" says so rather than inventing a value.
 */
export function diffLines(seed: ProviderMetadata, values: ProviderFormValues): ProviderDiffLine[] {
  const lines: ProviderDiffLine[] = [];
  const add = (field: string, current: string, proposed: string) =>
    lines.push({ field, label: PROVIDER_FIELD_LABELS[field] ?? field, current, proposed });

  if (seed.displayName !== values.displayName.trim()) {
    add("displayName", seed.displayName, values.displayName.trim());
  }
  if (seed.authorizeEndpoint !== values.authorizeEndpoint.trim()) {
    add("authorizeEndpoint", seed.authorizeEndpoint, values.authorizeEndpoint.trim());
  }
  if (seed.tokenEndpoint !== values.tokenEndpoint.trim()) {
    add("tokenEndpoint", seed.tokenEndpoint, values.tokenEndpoint.trim());
  }
  if (!setEqual(seed.requestedScopes, values.requestedScopes)) {
    add("requestedScopes", seed.requestedScopes.join(", "), values.requestedScopes.join(", "));
  }
  const origins = canonicalOrigins(values.apiOrigins);
  if (!setEqual(seed.apiOrigins, origins)) {
    add("apiOrigins", seed.apiOrigins.join(", "), origins.join(", "));
  }
  const placement = placementFromForm(values);
  if (JSON.stringify(seed.tokenPlacement) !== JSON.stringify(placement)) {
    add(
      "tokenPlacement",
      describeTokenPlacement(seed.tokenPlacement),
      describeTokenPlacement(placement),
    );
  }
  if (values.clientId.trim() !== "") {
    add("clientId", "stored client identity (never displayed)", values.clientId.trim());
  }
  return lines;
}
