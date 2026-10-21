# 0052. Evergreen agent skill, docs-first reference, and the npx CLI

**Status:** Accepted (2026-10-19). Supersedes decisions 1 and 6 of ADR [0036](0036-deployment-capability-catalogue.md).
**Related:** ADR [0028](0028-deployment-model-customer-deployed.md) (customer-deployed, so deployments lag `main`), [0032](0032-cli-naming-and-distribution.md) (CLI naming and npm distribution), [0036](0036-deployment-capability-catalogue.md) (capability catalogue). **Code:** `packages/deploy-skill`, `apps/docs/src/apps/`, `packages/cli/src/{capabilities,compat}.ts`, `packages/shared/src/deployment.ts`.

## Context

The agent skill (`packages/deploy-skill/SKILL.md`) was the platform's only full
reference for app authors. It was 666 lines, and the public docs site's
quickstart was generated from it. Users downloaded it from the portal or with
`helix skill`, and the portal substituted live values into it: servable models,
deploy caps, and approval baselines.

Two problems followed from that:

- **A downloaded skill goes stale and there's no way to update it.** Values were
  correct on the day of download. After the next release or the next operator
  change, the copy in an agent's `.claude/skills/` was wrong, and the only fix was
  telling everyone to download it again. All 42 KB also loaded into the agent's
  context every time the skill triggered, mostly API detail the task didn't need.
- **Users had to keep a global CLI up to date.** Docs and the skill said
  `npm i -g @azx-pbc/helix-cli`. People driving an agent don't know or care that
  the CLI can be outdated, so outdated installs were the norm.

Meanwhile the public docs site landed. It publishes markdown twins of every page
and `llms-full.txt`, so an agent can fetch exactly the page it needs.

## Decision

1. **The docs are the reference.** `apps/docs/src/apps/` is hand-written and
   holds the full app-author story:
   - the quickstart;
   - the manifest;
   - the gateway (identity, LLM, data, fetch proxy);
   - serving rules and CSP;
   - connected accounts;
   - error codes;
   - the CLI;
   - deploying from GitHub;
   - the dev gateway.

   The skill is not their source, and nothing generates them.

2. **The skill holds only what stays true without being updated:**
   - rules an agent breaks before it would think to look anything up;
   - this deployment's topology (portal origin, apps host, dev-gateway base),
     which is fixed once deployed;
   - pointers to things that stay current by themselves.

   It must never state a value that changes per release or per deployment. Tests
   in `packages/deploy-skill` enforce this. They reject model ids, dollar and MB
   figures, a global install, and growth past 200 lines, and they check that
   every docs link names a page the site builds.

3. **Live values come from `helix capabilities`.** A new CLI command formats
   `GET /api/v1/capabilities`, ADR-0036's catalogue. Agents are already signed in
   through the CLI, so this is one command, not a hand-built authenticated
   request. When the portal sends a shape the CLI's schema doesn't accept, the
   command prints the raw JSON instead of failing.

4. **People run the CLI with `npx -y @azx-pbc/helix-cli@latest`.** It is always
   current and there is nothing to install. The explicit `@latest` stops npx
   reusing a cached copy, and `-y` skips a prompt an agent can't answer. A global
   install stays documented as an option for people who want it. **CI pins an
   exact version** for reproducible deploys: `helix ci init` writes the version
   it ran as. Hand-copied snippets that can't know a version use `@latest`, with
   a comment pointing at `ci init` for the pinned form.

5. **A minimal CLI/portal handshake.** Always running the newest CLI means it
   can be newer than a customer's portal (ADR-0028), and an old global install
   can be older. The portal has no build version of its own, so the contract is
   a single constant, `MIN_CLI_VERSION` in `@azx-pbc/shared`:
   - `GET /api/v1/config`, which is public, returns it as `cli.minVersion`.
   - Every CLI command except `logout` reads it and **warns** on stderr when the
     CLI is older. It never fails the command, and an unreachable portal or an
     unparsable value skips the check.
   - Going the other way, a 404 from the portal's route-level not-found handler
     (`route … not found`, as opposed to "app not found") is reported as "this
     portal is probably older than this CLI".
   - Bump `MIN_CLI_VERSION` by hand when the portal removes or changes something
     an older CLI relies on. Adding routes never needs a bump.

## Consequences

- **This is the last skill re-download.** After it, platform changes land in the
  docs and the catalogue, and existing skills pick them up by reference.
- **Docs pages under `/apps/` are a public, stable URL surface.** Downloaded
  skills link them by path. Renaming or removing one breaks every copy in the
  field, so a page that moves needs a page at the old path pointing to the new
  one.
- **The docs describe `main`, not the deployment.** A customer running an older
  release can read docs for features it doesn't have yet. The skill tells agents
  that `helix capabilities` and the portal's own errors take precedence. Versioned
  docs would close the gap and are left as follow-up work (`TODO.md`).
- **The skill needs network access to be fully useful.** An agent with no web
  access gets the rules, the addresses, and the deploy flow, but not API detail.
  The rules in the skill are chosen to cover the mistakes that are expensive to
  undo, so an offline agent still avoids those.
- **`@latest` in interactive use means every new CLI release reaches users
  immediately.** A broken release affects everyone at once. Trusted publishing
  with provenance (ADR-0032) still protects where the package comes from, and
  CI deploys stay pinned.
- **Telemetry:** no new edge or egress seam. `/api/v1/config` gains one field,
  the portal deliberately has no instruments (ADR-0037 decision 8), and the CLI
  is outside the platform's telemetry boundary.
