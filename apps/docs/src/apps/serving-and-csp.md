---
title: Serving rules and CSP
description: "How Helix serves an app: the Content-Security-Policy every page gets, which CDNs load without a grant, the ban on app service workers, SPA fallback and caching, reserved paths, and the offline capability with its build pitfalls."
---

# Serving rules and CSP

The platform serves your build output as it is, and attaches a few rules to
every response. Most of them can't be worked around after the fact, so check
them before choosing libraries or a build layout.

## The Content-Security-Policy

Every app response carries this policy:

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' <CDNs>;
style-src  'self' 'unsafe-inline' https://fonts.googleapis.com <CDNs>;
font-src   'self' data: https://fonts.gstatic.com <CDNs>;
img-src    https: data: blob:;
media-src  'self' data: blob:;
connect-src 'self';
worker-src 'self' blob:;
form-action 'self'; frame-ancestors 'none'; base-uri 'self';
report-uri /_csp-report
```

`<CDNs>` stands for these hosts, which need no grant: `cdnjs.cloudflare.com`,
`cdn.jsdelivr.net`, `unpkg.com`, `esm.sh`, and `cdn.tailwindcss.com`.

The rule that matters most is **`connect-src 'self'`**: the page can't
`fetch()`, open a WebSocket to, or stream from any other origin. You have two
options:

- Route the call through the [fetch proxy](./gateway#calling-external-apis),
  `/_api/fetch/<url>`. This needs a `fetch.origins` grant.
- Ask for an `externalOrigins` grant, which adds the origin to `connect-src` and
  `img-src`. Use it for public, keyless APIs that allow cross-origin requests.

Both grants need admin approval. Each upload runs a CSP lint that warns about
origins this policy will block, so read those warnings before you promote.

## Other serving rules

- **No service worker of your own.** A request to register one is refused with
  `403`. Plain web workers are fine. For offline use, ask for the
  [offline capability](#offline) and the platform supplies the worker.
- **Client-side routing works.** A request that accepts HTML and matches no file
  gets `index.html`.
- **Caching:** HTML is served `no-cache`. Other assets get a short private cache
  with ETags.
- **Reserved paths:** the platform owns `/_api/*`, `/_auth/*`, and `/_helix/*`.
  Don't route on them.

## Offline

An app can start with no network connection if it asks for the `offline`
capability:

```yaml
offline:
  scope: /app/
```

The platform then serves its own service worker, limited to that path prefix,
and adds the registration code to your HTML. **Write no worker code and no
`register()` call.** The scope must not be the domain root or a `/_…` path. A
new grant or a scope change needs admin approval.

### Build changes

- **Serve the app from the scope.** Set your bundler's base path to `/app/`.
- **Put the build output under that directory too.** A URL path maps directly to
  a file in the bundle, so `/app/main.js` reads `app/main.js`. With Vite, that
  means `base: "./"` plus `build.outDir: "dist/app"`. Setting only the base
  produces URLs that look right and all return 404.
- **Add a root `index.html` that redirects into the scope.** The platform won't
  add one, so without it the bare domain returns 404.
- **Add a web app manifest** with `start_url: /app/`, because an offline start
  from the bare domain isn't possible:

```html
<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials" />
```

**`crossorigin="use-credentials"` is required on any app that isn't `public`.**
Browsers fetch a web app manifest without cookies by default. Without the
attribute, the request has no session, the platform answers `401`, and the app
silently can't be installed while everything else looks fine. This applies to
any app with a web app manifest, offline or not.

### What the grant covers

The grant covers **starting up** offline: the page and its static assets load
without a network. The rest is up to your code, and needs no grant:

- handling `/_api/*` failures;
- IndexedDB or `localStorage` for data that must survive;
- `caches.open()` for large payloads;
- sending queued work once the connection returns.

`GET /_api/me` is never served from the cache, so it works as a connectivity
check.

The platform's scripts, the fetch shim and the worker registration, are written
into your HTML when it is served, so they are cached with the page. On an
offline start, a proxied call fails as an ordinary network error you can catch,
not as a CSP violation.

The [`offline` example](https://github.com/AZX-PBC-OSS/helix/tree/main/examples/offline)
shows a complete setup.
