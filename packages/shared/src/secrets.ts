import { z } from "zod";

import { EnvSchema } from "./env.js";

/**
 * Connection secrets (design doc `docs/design/secrets-and-connections.md`).
 *
 * A **secret** is opaque credential material (an API key, PAT, bearer token)
 * the platform holds so an app never does. The app references it by name from a
 * proxy connection (manifest `capabilities.fetch.origins[].connection`); the
 * `azx-egress` service resolves it to plaintext and injects it server-side on
 * the outbound hop (§4). Secrets are **write-only / rotate-only** — the value is
 * never returned to anyone after it is set (§3), so the shapes here carry
 * metadata only; the value travels in the create/rotate request bodies and
 * nowhere else.
 */

/**
 * Header names a recipe may never write. `host` is the dangerous one: undici
 * special-cases it into `request.host` and *derives TLS SNI from it*
 * (`undici/lib/core/request.js` — the `headerName === 'host'` branch, and
 * `this.servername = servername || getServerName(this.host)`), which our SSRF
 * connector then honours. The IP pin still holds, but the Host line and the
 * cert-validation name would become recipe-author-chosen — vhost confusion on an
 * upstream the app was allowlisted for only one name of. The rest are framing
 * headers undici also special-cases, and `x-helix-` is ours (the attested
 * instruction rides those names between the edge and egress).
 */
const FORBIDDEN_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "te",
  "upgrade",
  "expect",
  "trailer",
]);

/** RFC 7230 `token` — the only characters legal in a header field name. */
const HEADER_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Every header name a recipe writes goes through this. It **normalises to
 * lowercase** rather than requiring it: `name` was free text before this (and the
 * portal SPA takes it as such), so stored rows may carry any case and the schema
 * re-parses on every read in both the portal and egress — rejecting would fail
 * those reads. Normalising is also the stronger guarantee, since egress compares
 * the names it injected against lowercased upstream response keys to strip them
 * (issue #7): a name that cannot round-trip that comparison cannot be stripped,
 * and after this it always can. The reserved-name check runs post-normalisation.
 */
const headerName = () =>
  z
    .string()
    .min(1)
    .max(64)
    .regex(HEADER_TOKEN, "must be an RFC 7230 token")
    .transform((n) => n.toLowerCase())
    .refine((n) => !FORBIDDEN_HEADER_NAMES.has(n), "reserved header name")
    .refine((n) => !n.startsWith("x-helix-"), "reserved header prefix");

/**
 * Printable ASCII + tab — exactly the subset undici will put on the wire
 * (`headerCharRegex = /[^\t\x20-\x7e\x80-\xff]/`, rejected at Request
 * construction). CR and LF fall outside it, so request splitting via a template
 * is not achievable at the transport either; validating here turns a 502 at 3am
 * into a 400 at write time.
 */
const HEADER_VALUE_SAFE = /^[\t\x20-\x7e]*$/;

/**
 * How a resolved secret is applied to the outbound request (§2). The recipe is a
 * property of the *credential* (how a given key is presented is intrinsic to it),
 * not of the app using it.
 *
 * Three of the four are **static** shapes — the stored value is presented
 * verbatim. `hmac-timestamp` is a **stateless derivation**: computed per request,
 * but from the credential and the clock alone, with no token cache, no network
 * call, and no request context. Recipes that are *stateful or networked* (OAuth
 * client-credentials, SigV4 with session tokens, mTLS) remain deferred — see
 * design §10 q2.
 */
export const InjectionRecipeSchema = z.discriminatedUnion("kind", [
  /** `Authorization: Bearer <secret>` — the common case. */
  z.object({ kind: z.literal("header-bearer") }),
  /** Arbitrary header; `{}` in `template` is replaced with the secret. */
  z.object({
    kind: z.literal("header"),
    name: headerName(),
    template: z.string().max(512).regex(HEADER_VALUE_SAFE).default("{}"),
  }),
  /** Query parameter `?<param>=<secret>`. */
  z.object({ kind: z.literal("query"), param: z.string().min(1) }),
  /**
   * HMAC over a timestamp. The signed input is the timestamp string **alone** —
   * not the method, path, query, or body — so injection is a pure function of
   * (private key, now) and needs no request context.
   *
   * The canonical form lives in the KIND NAME, deliberately. A scheme that signs
   * method+path+body is a *sibling kind* (`hmac-request`) — a code change with
   * tests, reviewed — never an admin-editable canonical-string template.
   * Canonicalization is where implementations of this family go wrong, and it
   * does not belong in a text box.
   *
   * SHA-256, lowercase-hex, and ISO-8601-with-milliseconds are fixed rather than
   * configurable. Each would carry a default, and `app_secrets.injection` is a
   * schemaless JSON column, so adding a knob later is purely additive with no
   * migration — while fixing them now removes the weak-algorithm and
   * unencodable-digest failure classes outright.
   *
   * The stored value is a JSON blob carrying both halves of the key pair
   * ({@link HmacCredentialSchema}): regenerating the pair changes both, and a
   * blob rotates atomically through the existing rotate route.
   */
  z.object({
    kind: z.literal("hmac-timestamp"),
    /** Header carrying the timestamp that is also the entire signed input. */
    timestampHeader: headerName(),
    /** Header carrying the rendered credential + signature. */
    authHeader: headerName().default("authorization"),
    /**
     * Value written to `authHeader`. `{credential}` and `{signature}` are
     * substituted. Named rather than the `header` kind's bare `{}` because there
     * are two substitutions: the convention is one value ⇒ `{}`, more than one ⇒
     * named placeholders. Positional `{}` here would let a swapped template
     * produce a well-formed header that silently fails to authenticate.
     */
    template: z
      .string()
      .min(1)
      .max(512)
      .regex(HEADER_VALUE_SAFE)
      .refine((t) => t.includes("{signature}"), "template must contain {signature}"),
  }),
]);
export type InjectionRecipe = z.infer<typeof InjectionRecipeSchema>;

/**
 * Injection recipe kinds, for UI selects / tests without restating strings. Hand
 * maintained because the order is the UI select order; a test asserts it against
 * the union's discriminators so it cannot drift.
 */
export const INJECTION_KINDS = ["header-bearer", "header", "query", "hmac-timestamp"] as const;

/**
 * The `value` for an `hmac-timestamp` secret: both halves of the key pair.
 * `credential` is the public half (sent in the clear on every request); `key` is
 * the HMAC key and never leaves egress.
 *
 * Both live in the one sealed value on purpose. The recipe is immutable after
 * create, and {@link SecretRotateRequestSchema} touches only the material — so
 * packing the pair means a regenerated pair rotates **atomically** through the
 * existing route, where splitting the public half into the recipe would force a
 * delete-and-recreate and break the manifest binding in between. The cost is
 * that {@link SecretMetadataSchema} cannot show *which* pair is installed.
 */
export const HmacCredentialSchema = z.object({
  credential: z.string().min(1),
  key: z.string().min(1),
});
export type HmacCredential = z.infer<typeof HmacCredentialSchema>;

/**
 * Parse an `hmac-timestamp` credential blob.
 *
 * The thrown message is a **fixed string** and must stay one. V8 embeds a ~10
 * character prefix of its input in `JSON.parse` errors (`Unexpected token 'g',
 * "ghp_LIVESE"... is not valid JSON`), and this input is a private key — so the
 * raw error must not escape, must not be attached as `cause` (pino's serializer
 * walks it), and must not be interpolated into any message.
 */
export function parseHmacCredential(value: string): HmacCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("hmac-timestamp value is not valid JSON");
  }
  const parsed = HmacCredentialSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('hmac-timestamp value must be {"credential":…,"key":…}');
  }
  return parsed.data;
}

/**
 * Guard the recipe⇄material pairing, in **both** directions.
 *
 * The recipe is fixed at create; the value is rotatable and was previously
 * unvalidated, so the two can drift. The dangerous direction is the quiet one: an
 * hmac blob stored under a `header-bearer` recipe sends
 * `Authorization: Bearer {"credential":…,"key":"<private>"}` to the third-party
 * upstream, putting the **private** half in a vendor's access log in cleartext
 * (and in the URL, for a `query` recipe). App-scoped secrets are written by the
 * app owner rather than an admin, so that is self-service, not just an ops slip.
 *
 * Enforced at the portal before sealing, and again in egress after opening, so
 * rows written before this existed also fail closed. Throws with a fixed string;
 * never interpolates the material.
 */
export function validateMaterialForRecipe(recipe: InjectionRecipe, value: string): void {
  if (recipe.kind === "hmac-timestamp") {
    parseHmacCredential(value);
    return;
  }
  // A static recipe presents the material verbatim, so a blob would ship the
  // private half upstream. Reject anything that parses as an hmac credential.
  if (HmacCredentialSchema.safeParse(safeJsonObject(value)).success) {
    throw new Error(`a ${recipe.kind} secret must not hold an hmac-timestamp credential blob`);
  }
}

/** JSON.parse that swallows both the error and its input-echoing message. */
function safeJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Secret scope (§2). `app` secrets are usable only by their owning app; `global`
 * secrets are usable by many apps, but only via an explicit per-app grant
 * (`app_secret_grants`) — "global" never means "ambiently available". `platform`
 * secrets are platform vendor credentials (the LLM key) with `appId = null`: not
 * grantable to apps and not bindable from a manifest, resolvable by egress only
 * for the edge's `llm` capability — never via an app's fetch binding (§4).
 */
export const SECRET_SCOPES = ["app", "global", "platform"] as const;
export const SecretScopeSchema = z.enum(SECRET_SCOPES);
export type SecretScope = z.infer<typeof SecretScopeSchema>;

/**
 * What the portal returns about a secret — never the value. `boundApps` lists
 * the app slugs that reference this secret (own app for `app` scope; granted
 * apps for `global`). `lastUsedAt` drives the stale-secret report (§6).
 */
export const SecretMetadataSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  scope: SecretScopeSchema,
  /** Partition tier (dev-mode §6): a dev fetch injects only `dev` connection secrets. */
  env: EnvSchema,
  injection: InjectionRecipeSchema,
  createdBy: z.string(),
  createdAt: z.string(),
  rotatedAt: z.string().nullable().optional(),
  lastUsedAt: z.string().nullable().optional(),
  boundApps: z.array(z.string()).default([]),
});
export type SecretMetadata = z.infer<typeof SecretMetadataSchema>;

/**
 * Create-secret request body. The `value` is the only place plaintext crosses
 * the API boundary; it is encrypted (dev) or written to Key Vault (prod) and
 * never read back (§3).
 */
export const SecretCreateRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits, and hyphens"),
  value: z.string().min(1),
  /** Target tier (dev-mode §6). Defaults `prod`; `dev` configures a dev-tier credential. */
  env: EnvSchema.default("prod"),
  injection: InjectionRecipeSchema.default({ kind: "header-bearer" }),
});
export type SecretCreateRequest = z.infer<typeof SecretCreateRequestSchema>;

/** Rotate-secret request body — a new value for an existing name. */
export const SecretRotateRequestSchema = z.object({ value: z.string().min(1) });
export type SecretRotateRequest = z.infer<typeof SecretRotateRequestSchema>;

/** Grant a `global` secret to an app (admin-only, approval-gated — §7). */
export const SecretGrantRequestSchema = z.object({ appSlug: z.string().min(1) });
export type SecretGrantRequest = z.infer<typeof SecretGrantRequestSchema>;
