---
title: Quickstart — build and deploy an app
description: "From an empty directory to a live Helix app: the rules an app must follow, helix.json, the capability manifest, and the npx-based deploy flow, with links to the reference for each part."
---

# Quickstart

This page goes from an empty directory to a live app. Each step links to the
page with the details. It works whether you are writing the app yourself or
pointing a coding agent at it. Agents can fetch any page here as markdown by
adding `.md` to its URL, or fetch the whole site in one file at
<https://azx-pbc-oss.github.io/helix/llms-full.txt>.

## What a Helix app is

Helix hosts web apps behind single sign-on, and it treats **every app as
untrusted code**. Rather than reviewing apps, it contains them. That shapes
everything below:

- **An app is a static frontend.** You ship HTML, CSS, JS, and assets. There is
  no server code, no environment variables, and no build step on the platform.
  Never put a secret in the bundle.
- **Everything dynamic goes through the [`/_api` gateway](./gateway)** on the
  app's own origin: language models, stored data, and calls to third-party APIs.
  You never hold an API key.
- **A strict [Content-Security-Policy](./serving-and-csp)** covers every page.
  It includes `connect-src 'self'`, so the browser cannot call another origin
  directly. Third-party calls go through `/_api/fetch/<url>`.
- **The [manifest](./manifest)** declares what the app may do, and the gateway
  enforces it. A capability you didn't declare answers `403`. Some grants wait
  for an admin to approve them.
- **Sign-in is handled for you.** `GET /_api/me` returns the signed-in user, so
  don't build a login screen.

## 1. See what your deployment offers

Each Helix deployment is configured by its operator: which models it serves,
which budgets apply without approval, and which API connections exist. Ask it:

```bash
npx -y @azx-pbc/helix-cli@latest login
npx -y @azx-pbc/helix-cli@latest capabilities
```

The [CLI page](./cli) explains the `npx` form. Below, `helix` means
`npx -y @azx-pbc/helix-cli@latest`.

## 2. Build the app

Any static-site toolchain works. Vite is the common choice, and plain
HTML/CSS/JS is fine. Build to a directory, `dist/` by convention. The
directory's **contents** become the site root, so `dist/index.html` is served
at `/`.

As you write the code:

- Call models with `POST /_api/llm/chat`. It is provider-neutral, so don't add
  a vendor SDK. See [Calling a language model](./gateway#calling-a-language-model).
- Store data with `/_api/data/*`. Per-user state goes in the `user` scope.
  Shared writes use compare-and-swap. See [Storing data](./gateway#storing-data).
- Call other APIs with `fetch('/_api/fetch/https://api.example.com/…')`. See
  [Calling external APIs](./gateway#calling-external-apis).
- Use `id` from `GET /_api/me` as the key for anything about a person. See
  [Identity](./gateway#identity).
- Show gateway errors to the user. See [Error codes](./errors).

## 3. Create the app

Add a `helix.json` next to your project. `portalUrl` is what points the CLI at
your deployment; without it, every command tries a local development portal.

```json
{
  "slug": "my-app",
  "dir": "dist",
  "portalUrl": "https://portal.example.com",
  "description": "Tracks Q3 cloud spend by team."
}
```

The portal's **How to develop** panel prints this file with your deployment's
URL. Write the description yourself: one plain sentence saying what the app
does and who it is for.

```bash
helix create --display-name "My App" --description "Tracks Q3 cloud spend by team."
```

## 4. Grant its capabilities

Open the app in the portal and set its manifest on the **Capabilities** tab.
List the models it calls, the data scopes it uses, and the origins it fetches,
each with a budget. Stay within the baselines `helix capabilities` reports and
the change applies at once. Anything beyond them queues for an admin. See
[Approvals](./manifest#approvals).

## 5. Deploy and promote

```bash
helix deploy            # uploads dist/ as a new preview version
helix versions          # preview vs live
helix promote <n>       # make it live
```

`helix deploy --promote` does both. Read the CSP warnings the upload prints.
Each one is a request that will be blocked in production.

To deploy on every push instead, see [Deploy from GitHub](./deploy-from-github).
To call the real gateway from a local dev server before you deploy, see the
[dev gateway](./dev-gateway).

## Before you call it done

- [ ] No server code, no `.env`, and no API key anywhere in the bundle.
- [ ] Every third-party call goes through `/_api/fetch/<url>`, or has an approved
      `externalOrigins` grant. Nothing relies on a plain cross-origin `fetch`.
      See [Calling external APIs](./gateway#calling-external-apis).
- [ ] Every capability the code uses is declared in the manifest, with a budget.
      See [the manifest](./manifest).
- [ ] `403` and `429` from the gateway are handled and shown to the user.
      See [Error codes](./errors).
- [ ] A provider-bound origin has a visible, labelled Connect button that starts
      the connect flow from its click handler. On `connection_required` it offers
      Connect, and the app re-issues the call itself; nothing retries
      automatically. See [Connected accounts](./connected-accounts).
- [ ] User-specific state is in `/_api/data/user/*`, not in `shared`.
- [ ] Every `shared` write sends `If-Match` (or `If-None-Match: *` to create)
      and retries a bounded number of times on `412`. See
      [Shared writes](./gateway#shared-writes-are-compare-and-swap).
- [ ] No self-maintained "index" key over a growing shared namespace. The
      prefix list call is the index.
- [ ] Nothing sensitive is written to a `shared` key or logged to the console.
- [ ] A web app manifest, if there is one, is linked with
      `crossorigin="use-credentials"`. See [Offline](./serving-and-csp#offline).
- [ ] The build has an `index.html` at its root and deploys without CSP lint
      warnings.

## Examples

The [example apps](https://github.com/AZX-PBC-OSS/helix/tree/main/examples)
are small, deployable references for each capability. Cloning one and changing
it is often faster than starting from nothing.
