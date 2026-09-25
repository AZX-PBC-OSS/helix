import { z } from "zod";

import { EnvSchema } from "./env.js";
import { HeaderNameSchema } from "./secrets.js";

/**
 * Connection providers — the administrator-configured vendor OAuth
 * registrations whose users' connections the platform delegates
 * (spec §Provider administration; ADR-0004 ref/id/revision keying).
 *
 * A **provider** is one vendor integration in one environment. A
 * **connection** is one user's consent to it. Nothing here handles
 * connections — only the provider rows the three writers that must agree
 * (the edit route, the import path, the invalidation transaction) read and
 * write through one definition.
 *
 * Every schema in this file is **strict**: unknown keys are rejected, not
 * stripped. An administrator edits these shapes through a form, and a
 * typo'd field name that zod silently dropped would apply a *different*
 * provider than the one the administrator reviewed — the same silent-strip
 * skew ADR-0005 closes on the instruction schema, closed here at write time.
 *
 * No request/stored parser split (unlike `secrets.ts`): the domain is
 * greenfield, every row is written through these schemas from the first
 * commit, so there is no legacy row shape a lenient read must tolerate.
 */

/**
 * The provider kinds a deployment can actually serve. Ships
 * `rest-delegated` only: values are added when each kind is implemented, so
 * an unimplemented kind cannot be configured even by hand (clarifications
 * Q21). Widening later is non-breaking — this package is source-exported.
 */
export const PROVIDER_KINDS = ["rest-delegated"] as const;
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/**
 * The provider's stable, human-readable reference — the key manifests and
 * the catalogue use, and the join the export document carries. Env-unique
 * (a `dev` and a `prod` row may share one); immutable after create.
 *
 * The secret-name convention, deliberately: administrators already type
 * these identifiers for connection secrets, and one shape reads in both
 * lists.
 */
export const ProviderRefSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits, and hyphens");
export type ProviderRef = z.infer<typeof ProviderRefSchema>;

/**
 * How the user's delegated access token is presented to the vendor's API
 * destination: `Authorization: Bearer` (the default) or one explicitly
 * named header. Query-string tokens and signing recipes are **not
 * representable** — the platform refuses token-bearing URLs outright
 * (spec §Provider administration, criterion 4).
 *
 * Two of the four `InjectionRecipe` kinds, and only those: a static secret
 * may ride a query param or an HMAC recipe, but a *delegated user token*
 * may not — it is the user's credential, and neither a logged URL nor a
 * signing recipe is an acceptable presentation for it. The kind names match
 * the recipe vocabulary so the two stay legible against each other.
 */
export const TokenPlacementSchema = z.discriminatedUnion("kind", [
  /** `Authorization: Bearer <access token>` — the default placement. */
  z.strictObject({ kind: z.literal("header-bearer") }),
  /** The access token verbatim in the named header (no template machinery). */
  z.strictObject({ kind: z.literal("header"), name: HeaderNameSchema }),
]);
export type TokenPlacement = z.infer<typeof TokenPlacementSchema>;

/** Placement kinds, for UI selects and tests without restating strings. */
export const TOKEN_PLACEMENT_KINDS = ["header-bearer", "header"] as const;

/**
 * One requested OAuth permission (RFC 6749 §3.3 `scope-token`): printable
 * ASCII excluding space, `"`, and `\`. The space exclusion is the load-bearing
 * one — scopes join with spaces on the wire, so a scope containing one is
 * indistinguishable from two scopes, and a CR/LF would travel into the
 * authorize URL the platform builds from this list.
 */
export const ScopeTokenSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/, "must be an RFC 6749 scope token");
export type ScopeToken = z.infer<typeof ScopeTokenSchema>;

/**
 * One API destination: the origin form only — `scheme://host[:port]`, no
 * path, query, userinfo, or fragment. Parsed to the canonical origin
 * (`new URL(...).origin`, so a trailing slash or an explicit default port
 * normalizes away) because every consumer compares origins as strings: the
 * app-binding rule matches a manifest origin against this list, and the
 * manifest side canonicalizes the same way.
 *
 * A path is **rejected** rather than normalized off: silently dropping
 * `https://vendor.example/api` to its origin would store a destination the
 * administrator never described. A non-http(s) scheme is rejected the same
 * way — egress only speaks http(s), so anything else is a misconfiguration
 * to catch at write time, not a 502 at call time.
 */
const API_ORIGIN_RULE =
  "an API destination is an origin — scheme://host[:port], no path, query, credentials, or fragment";

/**
 * The textual shape of a bare origin: `scheme://`, an authority containing
 * none of `/ ? # @ \` (`@` is userinfo; `\` is a path separator in WHATWG
 * special-scheme URLs), then at most one trailing `/`. Checked against the
 * **raw input** because the URL parser erases dot segments —
 * `https://host/private/..` and `https://host/%2e` parse to pathname `/`, so
 * a post-parse path check would accept exactly the inputs that describe a
 * path and store the bare origin instead.
 */
const BARE_ORIGIN = /^https?:\/\/[^/?#@\\]*(?:\/)?$/i;

export const ApiOriginSchema = z
  .url({ protocol: /^https?$/ })
  .superRefine((value, ctx) => {
    if (!BARE_ORIGIN.test(value)) {
      ctx.addIssue({ code: "custom", message: API_ORIGIN_RULE });
      return;
    }
    // Structural backstop on the parsed value, in case the textual guard and
    // the parser ever disagree about a shape neither anticipated alone. A
    // value can pass the textual shape and still be unparseable (an empty
    // authority, a broken bracketed host, a port past 65535, a malformed
    // percent escape) — and zod's URL-format issue is *continuable*, so this
    // refine runs even after that check already failed. Parse here must
    // therefore fail as a validation issue, never as an exception:
    // safeParse's contract is a result, and a route's input-rejection path
    // is not its unexpected-error path.
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: API_ORIGIN_RULE });
      return;
    }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      ctx.addIssue({ code: "custom", message: API_ORIGIN_RULE });
    }
  })
  .transform((value) => new URL(value).origin);
export type ApiOrigin = z.infer<typeof ApiOriginSchema>;

/**
 * A vendor OAuth endpoint. http(s) only — the fixture vendor is localhost,
 * the real ones are https — and **no userinfo**: the client registration
 * never rides the URL (`user:pass@host` would put a credential inside the
 * one string the export document carries, past its exclusion of credential
 * *fields*), so it is refused here, at the single definition every endpoint
 * field parses through.
 */
/**
 * The raw shape of userinfo in an endpoint URL: an `@` inside the authority.
 * `/` terminates the authority (so an `@` in a query value or path is not
 * userinfo), and `\` cannot appear in one. Two parser-input facts the guard
 * must reproduce exactly (WHATWG URL Standard §5.1): the special-authority
 * state ignores any number of `/` and `\` after the scheme separator, and
 * TAB/LF/CR are removed from the input before the authority is read — so
 * `https:///⇥/user:pass@host/oauth` parses with full userinfo. The guard
 * therefore applies the same removal and then matches; the mutation list is
 * finite and spec-defined, which is what makes this guard read exactly the
 * string the parser reads instead of playing whack-a-mole with spellings.
 *
 * Controls the guard does **not** sanitize for, and why that is safe:
 * leading C0 controls are rejected by the *overall* parse — zod's literal
 * `://` prefix check fails them even though the URL parser itself would
 * strip the controls and parse with userinfo (a stricter-than-parser
 * divergence that errs safe; the refine still runs on such values because
 * format issues are continuable, so nothing here may assume a failed prefix
 * check short-circuits it). Other interior controls (space, `\v`, `\f`) and
 * any other non-separator before the authority make the host itself
 * invalid — the parser throws, the format check fails, the parse fails.
 * Trailing controls sit after the path and cannot move an `@` into the
 * authority.
 */
const URL_PARSER_CONTROLS = /[\t\n\r]/g;
const ENDPOINT_USERINFO = /^https?:\/\/[/\\]*[^/?#\\]*@/i;

const OAuthEndpointSchema = z
  .url({ protocol: /^https?$/ })
  .refine(
    (value) => !ENDPOINT_USERINFO.test(value.replace(URL_PARSER_CONTROLS, "")),
    "a vendor endpoint URL must not carry userinfo — client auth is never configured in the URL",
  );

/** Bounded array sizes — sanity rails on admin input, not security limits (revisable policy). */
const MAX_API_ORIGINS = 16;
const MAX_REQUESTED_SCOPES = 32;

const noDuplicates = (values: readonly string[]) => new Set(values).size === values.length;

/**
 * The provider's API-destination list, as one definition: at least one
 * destination (a destination-less provider is unbindable dead configuration),
 * bounded, and duplicate-free after canonicalisation. The stored row and the
 * catalogue entry both parse through this — a derived entry cannot be
 * looser than the row it mirrors.
 */
const ApiOriginsSchema = z
  .array(ApiOriginSchema)
  .min(1, "a provider needs at least one API destination — nothing can bind to it otherwise")
  .max(MAX_API_ORIGINS)
  .refine(noDuplicates, "duplicate API destination");

/**
 * The requested-permission list as a bare rule (bounded, duplicate-free).
 * Create and the export document default it to empty — a hand-written
 * configuration legitimately says nothing about scopes; the update request
 * requires it, so default-ness is applied at the consumer, not baked into
 * the rule.
 */
const RequestedScopesSchema = z
  .array(ScopeTokenSchema)
  .max(MAX_REQUESTED_SCOPES)
  .refine(noDuplicates, "duplicate requested scope");

/**
 * The fields an administrator can edit on an existing provider — the one
 * place they are defined, so the create form, the edit form, and the import
 * diff cannot drift apart. `ref`, `env`, and `kind` are deliberately absent:
 * they are identity, not configuration, and are fixed at create.
 *
 * `requestedScopes` and `tokenPlacement` default here for the create/import
 * shapes (hand-written documents and scopeless vendors); the update request
 * and the stored row both re-declare them as required, each for its own
 * reason (see their docblocks) — the update request because a default there
 * would give one request body two absence semantics — required fields beside
 * absent-means-clear/reset — and manufacture a sensitive edit (both are on
 * {@link SENSITIVE_PROVIDER_FIELDS}) out of a field the administrator never
 * touched.
 */
const ProviderEditableFieldsSchema = z.strictObject({
  displayName: z.string().min(1).max(200),
  authorizeEndpoint: OAuthEndpointSchema,
  tokenEndpoint: OAuthEndpointSchema,
  requestedScopes: RequestedScopesSchema.default([]),
  apiOrigins: ApiOriginsSchema,
  tokenPlacement: TokenPlacementSchema.default({ kind: "header-bearer" }),
});

/**
 * A provider's credential-free configuration: exactly what the export
 * document carries and what create/import accept. Everything here can cross
 * a deployment boundary; no credential, token, secret reference, or
 * environment does (criteria 5, 11).
 */
export const ProviderConfigSchema = ProviderEditableFieldsSchema.extend({
  ref: ProviderRefSchema,
  kind: ProviderKindSchema.default("rest-delegated"),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/**
 * Create-provider request body. `clientId`/`clientSecret` are the only
 * place the vendor registration crosses the API boundary in plaintext —
 * write-only, like every secret value in this platform; the portal seals
 * both onto the row (ADR-0006 part 1) and neither is ever read back.
 *
 * `env` is required with no default, unlike `SecretCreateRequestSchema`'s
 * `prod` default: it selects the partition the whole vendor registration
 * lives in, is immutable after create (criterion 5), and an accidental
 * default is a registration in the wrong tier — the administrator chooses
 * it, explicitly, every time.
 */
export const ProviderCreateRequestSchema = ProviderConfigSchema.extend({
  env: EnvSchema,
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});
export type ProviderCreateRequest = z.infer<typeof ProviderCreateRequestSchema>;

/**
 * A key present with the value `undefined` is absence. JSON cannot carry the
 * distinction — serialization drops undefined values — but a typed caller
 * constructs it by spreading an optional form value onto the body, and
 * `.optional()` accepts it, preserving the key as an own property of the
 * parsed output. On this body such a key would counterfeit the presence
 * signal client-identity detection runs on, manufacturing a sensitive edit
 * out of nothing. Dropping undefined-valued keys before parsing makes
 * presence mean exactly "a value was supplied" — in a typed caller's
 * objects no less than on the wire.
 *
 * The copy is built with object **spread**, never indexed assignment:
 * spread defines own data properties, while assignment on a plain object
 * diverts an own `__proto__` key into the prototype setter — erasing the
 * key (and the strict refusal owed to an unknown one) or installing its
 * value as the copy's prototype, from which validation's property reads
 * promote inherited fields as supplied ones. JSON can carry an own
 * `__proto__` property (`JSON.parse` uses define-own semantics), so this
 * is an input shape to defend against, not a hypothetical.
 */
const undefinedKeysMeanAbsence = (body: unknown) => {
  if (typeof body !== "object" || body === null) return body;
  const withoutUndefined: Record<string, unknown> = { ...body };
  for (const key of Object.keys(withoutUndefined)) {
    if (withoutUndefined[key] === undefined) delete withoutUndefined[key];
  }
  return withoutUndefined;
};

/** An own `__proto__` key is never a provider field, whatever its value. */
const OWN_PROTO_KEY_RULE =
  "an own __proto__ key is not a provider field — the body is refused whole";

/**
 * Edit-provider request body. The editable fields are full-replace (the edit
 * form submits all of them) and therefore **all required** — an omitted
 * `requestedScopes` must be a malformed body, not "clear every scope", and
 * an omitted `tokenPlacement` not "reset to Bearer": both are sensitive
 * edits (criterion 6), and the route's parsed-request-vs-stored-row diff
 * cannot distinguish a manufactured default from an explicit choice.
 * `revision` is the loaded revision the optimistic lock compares against
 * (ADR-0004) — a stale save is rejected so the administrator reloads and
 * reviews rather than over a peer's edit.
 *
 * The credential fields are optional and **absent means keep**: the stored
 * material is never read back (criterion 3), so "blank" is the only way an
 * edit form can express "unchanged". `clientSecret` present is a rotation —
 * non-sensitive; `clientId` present is a client-identity change — sensitive
 * (see {@link SENSITIVE_PROVIDER_FIELDS}). Presence therefore always means
 * a value was supplied: a key carried with the value `undefined` is
 * normalised to absence on the way in ({@link undefinedKeysMeanAbsence}) —
 * the spelling of "not supplied" a typed caller's spread produces and JSON
 * itself cannot write. Absence on this body has exactly one meaning:
 * required fields fail, credentials keep.
 *
 * An own `__proto__` key is refused **on the input, after normalization**,
 * so it behaves exactly like every other unknown key: any valued spelling
 * (null included — JSON can write null) fails the parse, an undefined-valued
 * one is already absence. The refusal lives here because nothing else can
 * express it: zod's unrecognized-key walk steps over `__proto__` by design
 * (its own result object is built by assignment, so the key must not reach
 * it), and post-parse refinements run on that result, where the key no
 * longer exists. And this is the one body where the key is dangerous — the
 * normalizing copy once assigned it indexed-style, installing its value as
 * the copy's prototype so validation read a smuggled `clientId` or
 * `clientSecret` as supplied ({@link undefinedKeysMeanAbsence} now copies
 * with spread, which cannot divert the key; the refusal makes the rejection
 * explicit instead of relying on the copy alone).
 */
export const ProviderUpdateRequestSchema = z.preprocess(
  (body, ctx) => {
    const normalized = undefinedKeysMeanAbsence(body);
    if (
      typeof normalized === "object" &&
      normalized !== null &&
      Object.hasOwn(normalized, "__proto__")
    ) {
      ctx.addIssue({ code: "custom", message: OWN_PROTO_KEY_RULE });
    }
    return normalized;
  },
  ProviderEditableFieldsSchema.extend({
    requestedScopes: RequestedScopesSchema,
    tokenPlacement: TokenPlacementSchema,
    revision: z.int().positive(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
  }),
);
export type ProviderUpdateRequest = z.infer<typeof ProviderUpdateRequestSchema>;

/**
 * The stored `connection_providers` row — the shape both planes agree the
 * row has, mirrored by the portal's Prisma model and read by egress through
 * its revision-keyed cache.
 *
 * The credential fields carry **sealed material** — the opaque token
 * `SecretStore.seal()` produces (a dev AES-GCM envelope or a Key Vault
 * reference), never plaintext. The portal seals at create/rotate; egress
 * opens to build the vendor OAuth client; no read or export ever returns
 * either (criteria 3, 11). Sealing the identity half too costs one extra
 * vault open per provider revision and keeps "no plaintext credential on
 * the row" true without an exception for an identifier.
 *
 * `revision` starts at 1 and advances on every sensitive mutation and
 * deletion (ADR-0004) — one field serving admin concurrency, cache
 * invalidation, and consent staleness.
 *
 * The defaulted editable fields are re-declared **required** here, as the
 * update request re-declares them: a stored row is a complete record, not a
 * hand-written document, and defaults are an affordance of create and
 * import shapes alone. Every row is written through these schemas from the
 * first commit, so a row object missing its placement or scopes has no
 * legitimate producer — only a bug: a partial SELECT, a projection that
 * drops a column, a cache deserialization. The row's readers (egress's
 * revision-keyed cache, the portal's projections) must see that bug as a
 * parse failure, not as a valid row silently carrying a placement or scope
 * list nobody wrote.
 */
export const ConnectionProviderSchema = ProviderEditableFieldsSchema.extend({
  requestedScopes: RequestedScopesSchema,
  tokenPlacement: TokenPlacementSchema,
  id: z.uuid(),
  revision: z.int().positive(),
  ref: ProviderRefSchema,
  kind: ProviderKindSchema,
  env: EnvSchema,
  clientIdMaterial: z.string().min(1),
  clientSecretMaterial: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ConnectionProvider = z.infer<typeof ConnectionProviderSchema>;

/**
 * What management reads return about a provider — the row with **every
 * credential field removed**, structurally, so "no client credentials in a
 * read" (criterion 3) cannot drift into "returned empty": the fields do not
 * exist on this shape at all.
 */
export const ProviderMetadataSchema = ConnectionProviderSchema.omit({
  clientIdMaterial: true,
  clientSecretMaterial: true,
});
export type ProviderMetadata = z.infer<typeof ProviderMetadataSchema>;

/**
 * The admin providers-list response. `callbackUrl` is the fixed OAuth callback
 * an administrator registers with the vendor (design.md §Fixed callback
 * visibility, criterion 2), served at runtime beside the rows — derived by the
 * portal from the apps base by the reserved-subdomain convention, never a
 * build-time variable and never a second auth-base config field (architecture
 * ADR-0001 §Implementation Notes). One value per deployment, not per row.
 */
export const ProviderListResponseSchema = z.strictObject({
  callbackUrl: z.url(),
  providers: z.array(ProviderMetadataSchema),
});
export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>;

/**
 * The import/export document: one provider's credential-free configuration
 * as `{version, provider}` (criterion 11). The version is a literal — a
 * future format is a new literal and a new parser, so importing a document
 * this code cannot understand fails closed instead of silently dropping the
 * fields it does not recognize.
 *
 * Both directions parse this one schema: the export route serializes
 * against it, the import path parses against it, and the round-trip cannot
 * change meaning by construction — there is no second shape to drift from.
 */
export const ProviderExportDocumentSchema = z.strictObject({
  version: z.literal(1),
  provider: ProviderConfigSchema,
});
export type ProviderExportDocument = z.infer<typeof ProviderExportDocumentSchema>;

/**
 * One entry of the catalogue's `fetch.providers` list — the discovery
 * surface app authors bind against (criterion 3; Q16). Metadata only: never
 * a client credential, a token, or an endpoint. Raw env-pinned rows (a
 * provider configured in both environments appears twice); consumers join by
 * `ref`, which is why the ref is here and an `id` is not (ADR-0004).
 */
export const CatalogueProviderSchema = z.strictObject({
  ref: ProviderRefSchema,
  kind: ProviderKindSchema,
  displayName: z.string().min(1).max(200),
  apiOrigins: ApiOriginsSchema,
  env: EnvSchema,
});
export type CatalogueProvider = z.infer<typeof CatalogueProviderSchema>;

/**
 * The fields whose change is a **sensitive** provider edit (criterion 6):
 * every one of them invalidates existing connections and pending consent
 * attempts, blocks affected app bindings, and advances the revision
 * (ADR-0004). Display name and client-secret rotation are deliberately
 * absent — they preserve connections and approvals.
 *
 * The single definition the edit route's delta detection, the import path's
 * preview diff, and the invalidation transaction must all consume; none
 * restates it (ADR-0004 §Shared ground).
 *
 * `clientId` is detected by **presence in the update request**, not by
 * comparing values: the stored identity is sealed material no read returns,
 * so an administrator supplying a client id is itself the change signal.
 * The update schema's parse normalises an explicitly-`undefined` key to
 * absence, so what a consumer sees as present always carried a value.
 * Every other field compares old row against new request.
 */
export const SENSITIVE_PROVIDER_FIELDS = [
  "clientId",
  "authorizeEndpoint",
  "tokenEndpoint",
  "requestedScopes",
  "apiOrigins",
  "tokenPlacement",
] as const satisfies readonly (keyof ProviderUpdateRequest)[];
export type SensitiveProviderField = (typeof SENSITIVE_PROVIDER_FIELDS)[number];
