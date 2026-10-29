# Platform settings

Platform-wide settings an administrator edits in the portal under **Admin → Settings**
(`/admin/settings`). There are three sections:

1. **Operator.** Who runs this instance. The edge shows it to anonymous visitors.
2. **Blocked app-name terms.** Words a new app's slug may not contain.
3. **Portal configuration.** A read-only list of the portal's environment variables.

## Why these exist

Corporate web filters categorize a domain by what an unauthenticated crawler sees.
Before this feature, a crawler saw only two things on the apps domain:

- a password form on every protected app;
- a plain-text `Not found` at the root.

That form had a hidden username field, a password field and a link to a Microsoft
sign-in. That pattern matches a webmail login, and at least one vendor categorized
the domain as Web-based-Email, a category many enterprises block.

A client's name in an app's hostname, next to a sign-in form, adds a
brand-impersonation signal on top of that.

The settings address both problems:

- the anonymous pages now say what the site is and who runs it;
- administrators can stop client names from appearing in new app addresses.

## Operator identity

The operator identity has three optional plain-text fields: name (≤ 80 characters),
description (≤ 600) and contact link (`https:` or `mailto:` only).

They are stored in the single-row `platform_settings` table. The edge renders them,
escaped, on three pages:

- **The password page** (`GET /_auth/login` on an app host). It shows:
  - the title and heading "<name> access required", and a line saying the page is a
    private site hosted by <name>;
  - the access-code form;
  - an SSO link, "<name> staff? Sign in with SSO";
  - a fixed paragraph saying the site hosts privately shared apps;
  - the operator paragraph ("Operated by <name>." plus the description);
  - the contact link, labelled "Questions? Contact <name>: <address or host>";
  - a fixed "Built by AZX" footer linking `https://azx.io`.
- **The about page.** `GET /` on the bare apps domain, on the auth host, and on the
  reserved platform labels (`www`, `api`, `dev-api`) returns 200 with the same paragraphs and
  no form. Every other platform path is still a plain 404.
- **The fallback.** With no operator set, the operator paragraph is omitted and the
  heading, SSO link and contact label drop the name ("Access required", "Staff? Sign in
  with SSO", "Questions? Contact: …").

None of this copy mentions email, even to deny it: a text classifier counts the word
either way.

Some things are left off these pages on purpose:

- **No app name or description before sign-in.** Both are owner-written and often
  name a client. The page doesn't echo the slug as a form value either.
- **No product name in the fixed copy.** A rename then leaves these pages untouched.

### How the edge reads it

The edge reads the operator identity as part of its registry projection load
(`apps/edge/src/registry/projection.ts`):

- **Least privilege.** `helix_edge` has a column-scoped `SELECT` on the three
  operator columns and nothing else in that table, with no write access.
- **Refresh.** A statement-level trigger on `platform_settings` sends the same
  `helix_registry_changed` notification as `apps`, so a save reaches every edge
  replica within the listener's debounce.
- **Read failures don't take apps down.** A failed settings read never fails the
  load: the app map still swaps, the previous settings are kept, and the listener
  logs `registry.operator_settings_failed` at `warn` once when the read starts
  failing (and `registry.operator_settings_recovered` when it works again). That covers an edge that rolls
  out before the migration creating the table.
- **The dev gateway doesn't read it** (`includeOperatorSettings: false`).

## Blocked app-name terms

`blocked_slug_terms` holds one row per term, with an optional note and who added it.

**How matching works** (`blockedTermIn` in `packages/shared/src/app.ts`):

- A term matches when it appears as whole hyphen-delimited tokens. `acme` refuses
  `acme`, `acme-demo` and `q3-acme`, but not `acmeish` or `acme2`.
- A multi-token term such as `acme-energy` matches only that exact run.
- Terms are plain tokens (`SLUG_TERM_PATTERN`), never regexes, so an administrator
  can't write a slow or overbroad pattern.

**When it is enforced:**

- **App creation only.** `POST /api/v1/apps` refuses a blocked or reserved slug
  (`RESERVED_SUBDOMAINS`, now shared with the edge's host classifier). It returns
  400 `validation_failed` with `details: { field: "slug", reason, term? }`.
  - The message states the reason, because the SPA alert and the CLI print only
    the message.
  - The code is `validation_failed` rather than a new one: released CLIs parse the
    error envelope against the code list they shipped with.
  - Each refusal writes an `app.create.rejected` audit row.
- **Live feedback.** `GET /api/v1/slug-check?slug=` (any signed-in user) answers
  `ok`, or `invalid` / `reserved` / `blocked` / `taken` with the same message. The
  create form calls it as you type. It lives outside `/api/v1/apps/` so it can
  never shadow an app's slug.
- **Existing apps are untouched.** `AppSchema` is not changed, so stored apps keep
  parsing on read. The admin screen lists live apps whose slug already contains a
  blocked term, so an operator can decide whether to archive them.

The edge has no grant on `blocked_slug_terms`.

## Portal configuration

`GET /api/v1/admin/config` lists a fixed allowlist of portal environment variables
(`apps/portal/src/platformConfig.ts`):

- **Only listed names appear.** A variable added later stays hidden until someone
  adds it to the list.
- **Secrets report only set or not set.** Database URLs, `PORTAL_SECRET`, the
  internal JWT keys, dev tokens, the storage connection string and the dev KEK file
  never carry a value.
- **URLs that could carry a credential are withheld too.** A non-secret value
  that parses as a URL with userinfo, a query string or a fragment (where a SAS
  token rides) gets the same treatment.

The edge and egress have their own environments, which this screen does not show.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET/PUT /api/v1/admin/settings` | admin | Operator identity; `PUT` replaces all three fields, blank clears. Audited `platform.settings.updated`. |
| `GET /api/v1/admin/slug-terms` | admin | Terms plus `matchingApps`. |
| `POST /api/v1/admin/slug-terms` | admin | Add a term (lowercased and trimmed; 409 on duplicate). Audited `slug_term.added`. |
| `DELETE /api/v1/admin/slug-terms/:id` | admin | Remove a term. Audited `slug_term.removed`. |
| `GET /api/v1/admin/config` | admin | Portal configuration. |
| `GET /api/v1/slug-check?slug=` | signed in | Create-time feedback. |

## Tests

| What | Test file |
| --- | --- |
| Matching rules | `packages/shared/src/app.test.ts` |
| Portal routes, admin gating, audit rows, and the secret-sentinel check on the config route | `apps/portal/src/routes/platformSettings.test.ts` |
| Password page: no username field, escaping, contact-link scheme | `apps/edge/src/auth/password-login.test.ts` |
| About page | `apps/edge/src/serving/aboutPage.test.ts` |
| Projection behavior | `apps/edge/src/registry/projection.test.ts` |
| NOTIFY refresh | `registry.integration.test.ts` |
| Column-scoped grant | `role-split.integration.test.ts` |
| SPA screen and create form | `apps/portal-web/src/test/platform-settings.test.tsx`, `app-create-form.test.tsx` |
