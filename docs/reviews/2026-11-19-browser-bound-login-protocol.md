# Browser-bound login protocol review — 2026-11-19

Reviewed baseline: commit `7bf53a2`,
[browser-bound login design](../design/browser-bound-login.md).
Method: primary-source research, local library inspection, protocol attack
analysis, and one small Chromium experiment. No auth implementation or full
browser prototype was reviewed. This is one review, not an independent panel.

## Verdict

Proceed with the corrected design into a browser/security prototype. Do not treat
it as production-validated yet. The core ingredients are established: OIDC code
flow with PKCE, form-post response delivery, browser correlation cookies, and a
new session after authentication. Helix's second hop from its central auth origin
to an app origin remains a custom composition, not a standardized OAuth grant.

Research found one reproducible functional blocker in the baseline, plus missing
failure-state and abuse details. Corrections are incorporated into the design;
the evidence and remaining gates are below.

## Standards and implementation precedents

| Primary source | What it supports | Application to Helix |
| --- | --- | --- |
| [OpenID Form Post Response Mode, sections 2 and 4](https://openid.net/specs/oauth-v2-form-post-response-mode-1_0.html) | Auto-submitted form bodies are a standardized authorization-response transport; responses must not be stored/reused. | Entra form_post is standard. Reusing that transport for Helix completion does not standardize the completion protocol itself. |
| [RFC 9700, sections 2.1, 4.5, 4.7, 4.12](https://www.rfc-editor.org/rfc/rfc9700.html) | Transaction-specific PKCE/nonce and user-agent binding; CSRF defense; 303 for dropping sensitive POST bodies during redirection. | Retain state, nonce, PKCE, issuer validation, and exact callback handling. POST transport alone supplies none of these protections. |
| [RFC 6749, section 10.12](https://www.rfc-editor.org/rfc/rfc6749.html#section-10.12) | Callback CSRF protection binds a response to private browser state, with a session-cookie hash given as an example. | The temporary app cookie is a correlation mechanism; an ID in a URL alone is not browser binding. |
| [Microsoft ASP.NET Core SameSite guidance](https://learn.microsoft.com/en-us/aspnet/core/security/samesite?view=aspnetcore-10.0) | Remote-auth correlation and OIDC nonce cookies use None; cross-site cookies require Secure. | The proposed temporary-cookie attributes follow a deployed framework pattern; keep the ordinary session Lax. |
| [OWASP login-CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#possible-csrf-vulnerabilities-in-login-forms) | Use pre-authentication sessions and CSRF protection; replace the pre-session after login. | Do not promote the temporary cookie into a session. Test both victim-account theft and attacker-account injection. |
| [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) | Fresh session identifiers at authentication, server-enforced expiry, and protected cookies. | Retain fresh random session tokens and server-side revocation. |
| [Fetch Origin-header algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header) | For non-CORS POSTs, referrer policy can change the serialized Origin to null. | The completion page cannot combine no-referrer with a mandatory non-null auth Origin. |

These sources support the components and constraints. They do not establish that
our transaction state machine, SQL grants, failure handling, or worker behavior
are correct. Calling the cookie mechanism “PKCE” would also be misleading: PKCE
continues to protect the Entra code exchange; app completion has its own proof.

Local inspection confirms the installed openid-client declaration accepts
`URL | Request` in `authorizationCodeGrant`. The adapter can supply a POST
Request with a clean callback URL and form body. There is no need to synthesize a
query URL containing the code. Check the library's processing behavior in the
integration tests when implementing this adapter.

## Findings

### R1 — Blocker: no-referrer conflicts with exact Origin validation

The baseline requires no-referrer throughout login and rejects Origin: null at
completion. Fetch's non-CORS POST algorithm makes those requirements conflict.

Confirmed locally using Chromium 153.0.8010.12 via the installed Playwright.
Two ephemeral HTTP loopback servers used different ports. The source served an
HTML form with an automatic POST to the receiver. Only its Referrer-Policy changed:

| Source policy | Received Origin | Received Referer |
| --- | --- | --- |
| no-referrer | null | absent |
| strict-origin | source origin | source origin plus slash; no path or query |

This was a real browser form navigation, not request injection. It tested header
behavior only: no OIDC, cookies, HTTPS, cross-site privacy settings, Firefox, or
WebKit. To reproduce, serve a form between two localhost ports, set the policy
on the source response, and capture the receiving server's request headers.

Resolution: strict-origin on the auth-origin completion HTML, no-referrer on the
other login responses, and exact Origin validation retained. Add this negative
control to the later HTTPS browser lane. Do not allow null origins to hide the
problem; arbitrary sandboxed documents can also have null origins.

### R2 — Required: define ownership of state transitions

The baseline says failures delete or expire rows without distinguishing validated
failures from attacker requests. A caller knowing a transaction ID must not be
able to consume a ready proof by presenting the wrong cookie or body. Likewise,
repeated starts must not replace the OIDC attempt associated with a transaction.

Resolution: store the initiating OIDC state's hash once, check it when claiming
the callback, and accept completion consumption only after all bindings match.
Invalid completion leaves the transaction and unrelated cookies alone. A lost
network response after successful issuance can still require a restart; this
does not justify a credential-retrieval or idempotent replay endpoint.

### R3 — Required before implementation: bound unauthenticated work

The proposal adds database writes before authentication. Ten-minute expiration
limits lifetime, not request rate or peak row count. Public transaction IDs also
permit initialization races that can deny login even when they cannot steal it.

Specify initialization and restart limits using the existing shared CounterStore
and trusted-proxy client-IP handling. Include database-failure behavior, cleanup
capacity, and rejection telemetry. Numerical limits remain an implementation-plan
decision; they must be fixed before the new endpoint is shipped. Do not claim the
transaction ID has no security relevance merely because it is not a credential.

### R4 — Correct the research reference and browser claims

The Entra SameSite migration article linked in the baseline still contains advice
about Chrome-only None cookies and older browsers. Current ASP.NET Core guidance
is the better reference for cookie settings. Do not introduce that historical
user-agent sniffing into new code.

Top-level POST avoids an iframe/fetch dependency, but universal browser acceptance
has not been demonstrated. Test real separate sites and privacy settings. Missing
cookie or Origin fails closed; document any supported-browser limitation instead
of adding a URL-credential fallback.

## Security reasoning and its limits

The following is analysis of the proposed composition, not an empirical proof:

- An attacker who sends their own transaction to a victim owns its app cookie,
  but does not receive the completion proof emitted in the victim's auth-origin
  page. The victim's app cookie mismatches. This fails only if both checks remain
  mandatory and no result/proof retrieval endpoint exists.
- In the reverse attack, an attacker authenticates against a victim's exposed
  transaction ID. The attacker gets the proof but lacks the victim's app cookie.
  A forged browser POST from the attacker's origin must also fail the Origin check.
  Test this account-injection direction explicitly, including malicious sibling apps.
- HttpOnly prevents script reads, not authenticated requests by app code. Do not
  describe this as device attestation or protection from all same-origin compromise.
- A hostile root worker can inspect the form body. In particular, combining
  attacker-transaction substitution with proof interception undermines the
  separation above. The design retains the worker ban; it does not solve that
  larger threat model. A platform-owned root worker is a later, narrower decision.
- Body transport removes URL exposure, not all credential exposure. Request-body
  tracing, response-body capture, reverse proxies, browser tooling, and resubmission
  remain relevant. Keep short lifetime, one-time use, redaction, and no-store.

The existing app-origin isolation is essential. The completion HTML runs on the
trusted auth origin and contains no app-provided markup or scripts. A full
authorization server per app, shared parent-domain cookies, or access tokens in
app JavaScript would expand scope without solving this task more simply.

## Evidence still required

1. Browser prototype: both substitution directions, code/proof replay, missing
   cookies, exact/null Origin, stale tabs, manual submit, redirects, and silent
   refresh across same-site and separate-site HTTPS topology.
2. Storage proof: one callback attempt, one session issuance under concurrent
   replicas, RLS/grants, expiry, malformed-request non-consumption, and fault rollback.
3. Confidentiality checks: no code/proof in URLs, Location headers, spans, logs,
   error serialization, or app-visible responses. POST bodies are not safe to log.
4. Real Entra: existing client and redirect URI, form_post success and error paths,
   conditional-access interaction, and prompt=none. No registration change is
   expected; this review did not exercise the live registration.

No independent review or production-readiness conclusion is implied by a clean
repository check. The present changes are documentation and the small header
experiment only.
