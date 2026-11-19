# Browser-bound login without URL credentials

Status: proposed, 2026-11-19. This document specifies intended behavior; it does
not describe a shipped change or a security-reviewed protocol.

Related: [authentication](../features/authentication.md),
[ADR-0004](../adr/0004-auth-model.md),
[ADR-0019](../adr/0019-subdomain-per-app-isolation.md), and
[ADR-0035](../adr/0035-offline-capability-platform-service-worker.md).

## Goal and boundaries

Remove the Entra authorization code and Helix completion credential from login
URLs. Bind completion to the browser that started login, while retaining the
central callback, host-only sessions, server-side revocation, and existing
authorization checks.

Entra will receive the same client ID and callback URI, with
`response_mode=form_post`. No registration, consent, or permission change is
expected. Verify this against the existing registration before rollout.

Root offline support is separate work. Keep current scope validation, worker
registration restrictions, bundle layout, and offline behavior. The later work
should plan migration of existing offline apps to root, as requested, rather than
silently changing their scopes in this change.

Preserve active sessions. A coordinated deployment may require unfinished logins
to restart. Password login, portal authentication, CLI authentication, and
connection-provider OAuth flows are outside this change, except for updating
the password page's link into app-user SSO.

## Protocol

Use an opaque, single-use completion proof in a POST body **and** an independent
HttpOnly cookie on the app host. A public transaction ID is a correlation value;
it must never authorize completion or expose the result of authentication.

1. The session gate redirects an unauthenticated navigation to the app host's
   `GET /_auth/start`. This endpoint validates the return path, resolves the app,
   and creates a transaction with a fresh random ID and a fresh 256-bit browser
   secret. It stores only the secret's hash and sets `__Host-login` on that host.
   The return path, app ID, and silent-refresh flag are immutable transaction data.
2. Redirect to the auth host's `GET /start?app=<slug>&tx=<id>`. The auth host
   validates the app/transaction association and expiry, then creates the OIDC
   state, nonce, and PKCE verifier. Its signed HttpOnly flow cookie binds that
   OIDC attempt to this transaction. Client-supplied return paths cannot override
   the transaction. Legacy direct `/start?app=...&rd=...` entry links redirect
   through the app's initializer; they cannot bypass the browser cookie.
3. Entra POSTs its authorization response to the existing `/callback` URI.
   Verify the flow cookie and OIDC state, atomically claim the transaction's
   callback attempt, and exchange the code with PKCE and nonce validation.
   Re-resolve the app and check visibility. Failed or interrupted exchanges
   require a fresh transaction; do not reopen a claimed attempt.
4. On success, store the authenticated identity on the transaction and generate
   a new 256-bit completion proof. Store only its hash. Give it a 30-second
   lifetime, bounded by the transaction's expiry. The response is a small,
   platform-owned HTML page on the **auth origin**. It auto-submits a form to
   `POST https://<app>/_auth/complete`, carrying `tx` and `proof` in its body.
   Include a Continue button if script execution is unavailable.
5. Completion requires the expected auth Origin, the correct target app, an
   unexpired ready transaction, the proof, and a matching `__Host-login` cookie.
   Consume the transaction and insert a fresh active session in one database
   transaction. Recheck current app availability and visibility before issuance.
   Set the ordinary `__Host-session`, clear the temporary login cookie, and send
   a 303 to the stored return path. No session credential is returned in HTML,
   JSON, a response Location, or a query string.

The proof is never returned from an endpoint that accepts only `tx`. There is no
polling or status API exposing an authenticated result. A failed completion does
not set a session or fall back to the old URL-token path. Unknown, expired, and
mismatched credentials receive the same generic restart response.

### Why both proofs are necessary

A stolen public transaction ID must not let its holder redeem the result after
the victim signs in. Likewise, an attacker can initiate a transaction with their
own cookie and send its auth-start URL to a victim. The victim may authenticate,
but the resulting completion proof is delivered to the victim's browser, whose
app cookie does not match. The attacker has the matching cookie but does not
receive the proof. This separation is a design claim to verify with the attack
tests below, not a substitute for those tests.

Replacing the URL handoff with only a cookie lookup would lose that separation:
an attacker holding their transaction's cookie could poll or redeem after the
victim authenticated it. Do not activate a pending session at the OIDC callback.

## Cookies, browser behavior, and parsing

- `__Host-login`: Secure, HttpOnly, Path=/, no Domain, SameSite=None, ten-minute
  Max-Age. Only this temporary app cookie needs cross-site POST delivery. The
  normal session cookie remains SameSite=Lax.
- `__Host-oidc-flow`: retain its signed state/nonce/PKCE binding and ten-minute
  lifetime; change to SameSite=None; Secure for Entra's cross-site POST callback.
  Consume the corresponding server-side attempt once, not merely the cookie.
- Keep the current concurrency policy: a newer login overwrites the flow cookie;
  losing tabs fail safely and offer restart. A newer login on an app similarly
  replaces that app's temporary cookie. Do not silently bind an old proof to it.
- Accept bounded `application/x-www-form-urlencoded` bodies on the two POST
  endpoints only, with a 16 KiB body limit. Reject duplicate protocol fields,
  malformed encoding, missing required fields, and conflicting success/error
  responses. Validate with zod. Adapt the OIDC seam to accept a POST request
  through openid-client; do not reconstruct a credential-bearing callback URL.
- Do not require an Entra Origin allowlist as a replacement for OIDC state:
  issuer deployments can differ. The app completion endpoint, however, has one
  exact platform auth origin and rejects absent, null, or other Origins.
- Use a dedicated restrictive CSP on the auth completion page: no external
  resources, no framing, no base URL, nonce-authorized submission script, and
  form-action restricted to the computed app origin. Escape all HTML values.
  Never reuse the permissive app CSP or weaken app form-action.
- Send Cache-Control: no-store and Referrer-Policy: no-referrer throughout login.
  No credential-bearing HTML or POST body may enter logs or error diagnostics.
  Redirects after POST use 303; never forward the POST body with 307/308.

Top-level forms avoid dependence on credentialed cross-site fetch and third-party
iframe cookies. Browser verification must still establish cookie delivery under
the supported browsers' privacy settings, using separate sites as well as today's
same-site subdomains. Missing cookies fail closed; there is no URL fallback.

Microsoft documents the form_post/SameSite requirement in its
[SameSite guidance](https://learn.microsoft.com/en-us/entra/identity-platform/howto-handle-samesite-cookie-changes-chrome-browser).

## Storage and interfaces

Add an edge-owned `login_transactions` table through a portal migration. Store
the transaction ID, app ID, browser-secret hash, validated return path, silent
flag, creation/expiry timestamps, state, authenticated identity, proof hash, and
completion deadline. States are `created`, `exchanging`, and `ready`; successful
completion deletes the row atomically with session insertion. Failures delete or
expire the row. Every transition includes app, state, and expiry predicates.

Use ten-minute transaction expiry, with the shorter proof deadline at completion.
Extend the existing session sweep lifecycle to remove expired transactions;
expired rows must already be unusable before sweeping. Keep database operations
multi-replica safe and use parameterized SQL with the existing app partition
mechanism. The portal runtime and egress get no transaction read/write grants.
Keep portal session permissions at SELECT/DELETE: it cannot mint sessions.

Add a login-transaction store seam with initialization, callback claiming,
ready-result storage, atomic session issuance, and expiry cleanup operations.
Share a database transaction for final consumption and session creation; two
independent store calls are insufficient. Unit fakes must enforce the same state
transitions. Retain the password flow's active-session creation behavior.

Update the session gate, password SSO entry link, silent refresh, OIDC adapter,
route wiring, cookie helpers, and integration fixtures. Silent interaction-required
responses restart interactively through the app initializer with a new transaction.
Remove handoff-JWS minting/redemption and its dedicated key after cutover; retain
the flow-signing key and EDGE_AUTH_SECRET. GET completion and GET OIDC callback
must never accept legacy credentials; show a safe restart response instead.

## Security limits and telemetry

This proposal does not authorize app-owned root workers. A hostile worker can
observe or replace requests and read POST bodies; browser binding alone is not
proof against that attacker. Keep the platform's current worker restrictions.
The later root-worker design must separately test platform-worker passthrough,
caching, update, and revocation behavior.

Retain query redaction, forbidden URL attributes, and secret/header redaction.
Other platform flows and app URLs can still carry secrets. Add shared constants
and service-helper spans for initialization and the revised completion operation,
with bounded outcomes for expired flow, binding mismatch, replay, and storage
failure. Record no transaction ID, proof, cookie, code, identity, form body, or
full URL. Update the observability inventory and assert recording and disabled
telemetry behavior. Follow the existing telemetry design before implementation;
do not add inline SDK usage or new portal instruments.

## Attack matrix and acceptance evidence

| Scenario | Required result |
| --- | --- |
| Attacker sends their auth-start transaction to a victim | Victim's completion fails the app-cookie binding; attacker cannot retrieve the proof or redeem by transaction ID alone. |
| Transaction ID leaks through history or access logs | It cannot expose identity, retrieve a proof, or mint a session. Test before and after authentication. |
| Completion proof stolen without the app cookie | No session; no alternate GET or transaction-status route permits redemption. |
| Cookie from another browser or another app | Completion fails even with a valid proof. |
| Replay or simultaneous completion across replicas | Exactly one active session is issued. |
| Callback replay, mismatched state, nonce, or PKCE | No ready transaction and no session. |
| Expired transaction/proof; older login after cookie overwrite | Safe restart, without adopting the newer cookie or extending expiry. |
| Origin missing, null, sibling app, or attacker site | App completion fails. Origin spoofing in a headless client still cannot replace either secret. |
| App archived or access narrowed during login | Issuance denied; existing authorization checks remain effective. |
| Database failure before/during issuance | No partial activation; transaction rollback prevents a consumed proof without its session row. Lost responses may require restart. |
| Script disabled on the auth completion page | Manual Continue submits the same bound POST. |
| Browser back, refresh, duplicate POST, or silent-login interaction required | No replay activation or redirect loop; restart is explicit. |
| Request logs, spans, error paths, Location headers, and navigation URLs | Neither OIDC code nor completion proof is recorded there. |
| Password, public, existing sessions, logout, group refresh, and revocation | Existing behavior remains intact. |

Use unit adversarial tests, real Postgres role/RLS and concurrency tests, and the
in-process dev IdP integration flow. Add browser acceptance coverage for Chromium,
Firefox, and WebKit with actual HTTPS and cross-site IdP/auth/app navigation;
request injection alone cannot establish cookie or redirect behavior. Include
same-site topology, separate-site topology, third-party-cookie blocking, failed
cookie delivery, and response-history inspection. Use test-only hostile workers
to document the limit above; never relax production registration restrictions to
make a test fixture work.

## Implementation sequence and rollout

1. Review this protocol and implement its attack cases in a browser prototype.
   Treat a failure of binding or supported-browser cookie delivery as a design
   failure to resolve before replacing production auth. Record evidence in a
   dated review and adopt a new ADR superseding the relevant ADR-0004 decisions.
2. Add the additive schema migration, role tests, transaction store, and expiry
   cleanup. Implement app initialization, OIDC form_post, and bound completion
   together with adversarial and telemetry tests. Add no edge runtime dependency.
3. Update authentication documentation, architecture Appendix A, review guide,
   operator cutover instructions, and observability inventory. Amend worker
   documentation to describe the new transport without claiming root is allowed.
4. Run `./check-and-lint.sh` cleanly, plus the browser acceptance lane and a
   dedicated auth review. Verify login and silent refresh against real Entra's
   existing registration before production traffic is switched.
5. Apply the additive migration, then switch all edge traffic to the new revision
   without mixed-revision routing. Existing sessions continue working; unfinished
   old logins restart. Monitor bounded auth outcomes and storage failures.
   Rollback uses the previous edge revision and retains the additive table; new
   in-progress logins restart. Never roll back this way after a later change has
   enabled root workers: that would restore the exposed URL handoff beneath them.

No application auth implementation is authorized by this document's creation.
The current deliverable is the design and its validation plan; implementation is
the next stage after the protocol review.
