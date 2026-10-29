---
title: Platform settings
description: "Set who runs your install, keep client names out of app addresses, and check the portal's configuration — the admin Settings screen."
---

# Platform settings

Platform admins have a **Settings** screen in the portal, under **Admin →
Settings**. Do the first two steps below after your first deploy, before you
share any app with people outside your organization.

## Say who runs the install

Set the **Operator** fields:

| Field | What it is | Example |
| --- | --- | --- |
| Organization name | Your organization's name | `Example Co` |
| About | One or two sentences about who you are and what the site is for | |
| Contact link | An `https:` or `mailto:` link | |

These appear on two kinds of page anyone can see without signing in:

- the sign-in page of every password-protected app, whose heading reads
  "Example Co access required" and whose contact line reads "Questions? Contact
  Example Co: …";
- the home page of your apps domain.

All three fields are plain text, and you can leave any of them empty.

### Why set it

Many companies run web filters that decide whether a site is safe from what an
anonymous visitor sees. If that is only an unexplained sign-in form, the filter
can mistake your install for a webmail or phishing site and block it for
everyone at that company.

The pages already explain that the site hosts privately shared apps. Your
organization's name and contact link tell the filter, and the recipient, who
runs it.

The pages never show an app's name or description before sign-in. App owners
often write client names into them.

### If a filter still blocks you

Filters categorize each hostname separately, so one app can be blocked while
another is not, and a new app starts with no category of its own.

1. Set the operator fields, then check what an anonymous visitor sees: open
   your apps domain's home page and an app's sign-in page in a private window.
2. Ask the filter vendor to recategorize your apps domain, your auth host and
   each blocked app's address. Most vendors have a public URL-lookup page with a
   change-request form.
3. Ask the blocked company's IT team to allow `*.<your apps domain>`. This is
   the only fix that also covers apps you create later.

## Block client names in app addresses

An app's name becomes its web address: `acme-demo.<your apps domain>`. A
client's name in that address, next to a sign-in form, is a classic phishing
pattern, so web filters may block the whole domain because of it.

Add each client's name or abbreviation under **Blocked app-name terms**. Nobody
can then create a new app whose name contains that term as a whole word:

| Blocked term | Refused | Allowed |
| --- | --- | --- |
| `acme` | `acme`, `acme-demo`, `q3-acme` | `acmeish`, `acme2` |
| `acme-energy` | `acme-energy-demo` | `acme-demo-energy` |

The rule applies only when an app is created; existing apps keep their
addresses. The screen lists any live app that already uses a blocked term, so
you can archive it or ask its owner to recreate it under a neutral name.

Addresses `auth`, `portal`, `api`, `www` and `dev-api` are always reserved for the platform.

## Check the portal's configuration

**Portal configuration** lists the environment variables the portal was started
with. Use it to confirm a deploy picked up the setting you meant it to.

- The list is read-only. Change values through the deployment, as described in
  [Configuration reference](/deploy/configuration).
- Secrets show only whether they are set, never their value.
- The edge and egress services have their own settings, which are not listed
  here.

## If a client's filter still blocks you

Ask for a screenshot of the block page. It names the filtering product and the
category it assigned, such as "Web-based Email", "Newly Registered Domain" or
"Phishing".

Most vendors run a public site-review page where you can request a different
category. Do that once the operator fields are set, so the reviewer sees what
the site is.
