---
title: Connected accounts
description: "Calling a vendor API as the signed-in user: OAuth connection providers, the window.helix.connect() helper and the raw connect flow, verifying completion messages, and handling connection_required."
---

# Connected accounts

Some APIs should be called **as the signed-in user**, with that user's own
grant, not with a credential shared across the app. For those, an operator
registers an OAuth **connection provider**. Your app binds an origin to it, and
each user connects their own account.

The user's token stays on the server. At call time the platform adds it to the
proxied request, so it never reaches your code.

## Binding an origin to a provider

In the manifest, bind a fetch origin to the provider's ref:

```json
{
  "fetch": {
    "origins": [{ "origin": "https://app.acme.example", "provider": "acme", "required": true }]
  }
}
```

- `helix capabilities` and the portal's Capabilities tab list the providers you
  can bind and the API origins each one covers, per environment.
- An origin can use either a stored `connection` or a `provider`, never both.
- `required: true` tells reviewers the app depends on the provider. It never
  blocks or triggers anything.

Calls then go through the [fetch proxy](./gateway#calling-external-apis) as
usual: `fetch('/_api/fetch/https://app.acme.example/…')`.

## Connecting is always the user's choice

A user's connection is created only when that user explicitly agrees. The
platform never opens a popup on its own, never inspects your responses, and
never retries anything.

Your app shows a **Connect** control, a visible, labelled `<button>` such as
"Connect to Acme", and starts the flow from **inside its click handler**. Both
ways of starting it open a popup, and browsers block a popup that doesn't come
from a click.

### With the helper

Add `"shim": { "connect": true }` to the manifest, and the platform adds
`window.helix.connect()` to your HTML. It never throws or rejects; every result
is an outcome:

```js
connectButton.addEventListener("click", async () => {
  const result = await window.helix.connect("acme"); // the provider ref
  // result = { outcome, provider, attempt?, reason? }
  if (result.outcome === "connected" || result.outcome === "already_connected") {
    await refetchVendorData(); // re-issue the call that failed with connection_required
  }
});
```

| Outcome | Meaning |
| --- | --- |
| `connected` | The user approved, and the connection is saved |
| `already_connected` | A working connection already existed; nothing was sent to the vendor |
| `denied` | The user declined at the vendor |
| `cancelled` | The popup was closed before finishing. If it had in fact completed just before closing, your next call succeeds |
| `timeout` | The popup stayed open for five minutes |
| `blocked` | The browser blocked the popup. Offer Connect again; the platform never navigates your tab or retries |
| `signin_required` | There is no app session. Sign in, then Connect again |
| `error` | A platform-side problem. `reason` is one of `conflict`, `provider_unavailable`, `provider_misconfigured`, `provider_incompatible`, `service_unavailable` |

### Without the helper

Open the start route in a popup from the same click handler, and listen for the
completion message yourself:

```
GET /_api/connections/:ref/start          optionally ?attempt=<correlation tag>
```

This is a same-origin page on your app's host, so it checks the user's session
first. On success the popup goes straight to the vendor's consent screen.
Otherwise a platform page posts the outcome and offers a Close button.

The message only tells you what happened; it carries no token and grants
nothing. **Check every message before acting on it:**

1. `event.source` is the popup you opened.
2. `event.origin` is a platform origin: your app's own host, or the auth host
   that serves the completion pages.
3. The body has `source: "helix-connect"` and `version: 1`.
4. `provider` matches the ref you are connecting.
5. `outcome` is one of the values in the table above.
6. `reason` is `null` unless the outcome is `error`.
7. If the message carries an `attempt`, it matches the tag you sent.

Ignore anything that fails these checks.

## When a call fails

When a provider-bound call can't be served, the platform answers with
`{code, message, provider?}`:

| Status | Code | What to do |
| --- | --- | --- |
| `403` | `connection_required` | The user can fix this: there is no connection yet, they declined, the token died, or they disconnected. Offer Connect, and on `connected` or `already_connected` re-issue the call |
| `502` | `upstream_error` | Token renewal failed for now, or the vendor is down. The connection is kept; whether to retry later is up to you |
| `502` | `provider_misconfigured` | Administrator problem; retrying does nothing |
| `503` | `provider_unavailable` | Administrator problem; retrying does nothing |

**Helix never replays a call.** Whether to retry is your decision.

Anonymous visitors to a `public` app, and users of a shared-password app, can't
hold connections. For them `connection_required` is permanent, so don't show
them a Connect control.

## In the dev gateway

On a local dev origin, the platform serves only your `/_api/*` calls, so the
helper isn't available. Use the raw flow instead:

1. Call `POST <dev gateway>/<slug>/_api/connections/:ref/start` with your dev
   token.
2. The response is `{outcome: "started", popupUrl}`, or a final
   `already_connected` or `not_available`.
3. On `started`, open `popupUrl` in a popup. It works only once.
4. The completion message comes from the auth host. Check it exactly as above.

The connection belongs to the app's dev partition, like every other dev
credential. See [the dev gateway](./dev-gateway).
