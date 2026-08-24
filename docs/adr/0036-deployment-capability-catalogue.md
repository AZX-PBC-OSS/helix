# ADR-0036 — Deployment capability catalogue: an authed instance endpoint, deployment-agnostic public docs

## Status

Accepted. Decisions 1–6 and the `helix skill` CLI command landed; decision 7
(the public docs site) is deferred — `renderSkillGeneric()` is in place for it,
the site build itself is not. "Deferred" is a decision, not a proposal.

## Implementation (v1 scoping)

Three points the Decision left open were resolved at build time, and each
constrains the value the catalogue delivers today:

- **Servable models are derived from seeded `platform` secrets, not from the
  edge's routing table.** The portal can read `app_secrets` but cannot observe
  `RoutingLlmProvider.#byProvider` (the edge's boot-time wiring); no single
  component holds both facts. v1 assumes the **default symmetric wiring** — both
  families wired whenever egress is up, and the platform-secret name equal to
  the provider family (`anthropic`/`openai`). Under that assumption a model is
  servable when its `providerForModel(m)` family has a seeded platform secret,
  which closes the 502 (unseeded-secret) gap — the deployment-permanent fact the
  Context defects turn on. It does **not** close the 503 (family-not-wired) gap:
  a hand-wired single-vendor edge would still advertise models it cannot route.
  The invariant in Consequences ("the catalogue's model list must agree with
  `RoutingLlmProvider.supports()`") therefore holds *under the symmetric-wiring
  assumption*, not by construction. An operator who overrode
  `EDGE_LLM_*_CONNECTION` would see inaccurate filtering. Closing this fully
  needs the edge to report its wired families (a new field on `/health` checks[]
  or a new edge endpoint the portal reads at catalogue-build time) — additive,
  not blocking.
- **Connections are listed by name only, without the origin each fronts.** A
  `global`-scope secret has no stored origin — the origin is declared per-app in
  each manifest's `fetch.origins` — so the ADR's "each with the origin it fronts"
  cannot be honoured without inventing one. An agent learns a connection exists
  and is referenceable, and supplies the origin itself. Deriving origins from
  existing apps' manifests was rejected: that reports current usage, not a menu.
  Adding an optional origin/description field to `AppSecret` is the clean fix if
  this proves too thin.
- **The public docs site (decision 7) is deferred.** `renderSkillGeneric()`
  and the "no leftover `{{`" guard covering both render modes landed so the site
  can consume the generic render later; no site build is in this pass.

## Context

The agent skill bundle (`packages/deploy-skill`) is the platform's developer-facing
document: `SKILL.md` teaches an agent the static-frontend constraint, the CSP it must
build within, the capability manifest, the `/_api/*` gateway, and the deploy flow. It
is **deployment-templated on purpose** — `renderSkill(template, vars)` substitutes
`{{PORTAL_ORIGIN}}`, `{{APPS_HOST}}`, `{{DEV_API_BASE}}`, `{{LLM_MODELS}}`,
`{{MAX_FILE_MB}}`, `{{MAX_BUNDLE_MB}}`, and drops the `IF:DEV_API` block when the dev
gateway isn't deployed. `SkillVars` documents the seam precisely: "every field is a
value the control plane knows and the app author does not."

Two pressures now push on that arrangement.

1. **We want a public docs site.** The repo is open source
   (`github.com/AZX-PBC-OSS/helix`) and 77 markdown files under `docs/` are sorted by
   kind — ADRs, designs, dated reviews, runbooks. Almost all of it is contributor
   documentation: `docs/features/llm-gateway.md` opens with six ADR cross-links and
   then walks `apps/edge/src/gateway/llm.ts` handler by handler. The one document
   written for the app author is `SKILL.md` — and it cannot be published as-is,
   because under [ADR-0028](0028-deployment-model-customer-deployed.md) every
   deployment is a different customer's cloud with different hosts, models, and caps.
   There is no single true rendering to publish.

2. **The agent needs to know what this platform can do.** Today an agent learns the
   manifest's *schema* but not its *value space here*: which models are servable,
   which connections exist to reference from `fetch.origins`, whether `public`
   visibility is permitted, whether the dev gateway is up. It writes a manifest, and
   finds out at approval or call time.

Three concrete defects follow from having no instance-wide catalogue:

- **The skill has no server-side reader.** `renderSkill` is called in exactly one
  place, `apps/portal-web/src/modals/HelpModal.tsx`, in the browser, over a Vite
  `?raw` import. Nothing outside the SPA can obtain the skill — not the CLI, not an
  agent, not `curl`. `packages/deploy-skill/src/index.ts` already anticipates the
  missing consumer ("a future `helix skill` command would read it off disk").
- **Curated ≠ servable.** The SPA passes `llmModels: Object.keys(MODEL_PRICING)`,
  which is the same build-time constant as `CURATED_LLM_MODELS`
  (`approval.ts:111`). But per [ADR-0033](0033-openai-compatible-gateway-surface.md),
  a `gpt-*` model on a deployment that never seeded the `openai` platform secret
  502s at call time, and a model whose upstream family isn't wired 503s before a
  stream opens. The edge knows what it can actually serve; the skill lists what the
  bundle was compiled with.
- **The approval baselines are hardcoded prose.** `BASELINE_DOLLARS_PER_DAY` (50),
  `BASELINE_WRITES_PER_DAY` (10 000), `BASELINE_BYTES_PER_DAY` (50 000 000), and
  `BASELINE_FETCH_REQUESTS_PER_DAY` (10 000) drive
  [ADR-0016](0016-capability-manifest-approval-classifier.md)'s classifier. `SKILL.md`
  §2 restates all four as literal numbers, **not** as `{{PLACEHOLDER}}`s. That is
  accurate today because they are compile-time constants in `@azx-pbc/shared` — and
  it silently becomes a lie the first time a customer retunes one. The
  no-leftover-`{{` test cannot catch it, because there is no placeholder to leave
  over.

## Decision

Split the developer documentation by **what varies per deployment**, and let the
instance serve its own half.

1. **One template, two render modes.** `SKILL.md` stays the single authored source.
   `renderSkill(template, vars)` is unchanged — the instance rendering. A second
   `renderSkillGeneric(template)` substitutes *descriptive prose* for each
   placeholder ("your deployment's apps host — see `GET /api/v1/capabilities`")
   and keeps the `IF:DEV_API` block with a note that it is deployment-dependent.
   The public docs site consumes the generic render; there is no public *skill*,
   only public *docs*. The existing "no leftover `{{`" assertion extends to cover
   both modes, so a new placeholder fails the suite until both maps are wired.

2. **`GET /api/v1/capabilities` — the catalogue, instance-wide.** JSON, one
   deployment-scoped document, no per-app variance. It answers the manifest key by
   key: which `visibility.mode` values are available here (`group` requires an IdP
   with groups, so it is absent on a dev-token-only portal, matching
   `/api/v1/auth/config`'s 404); which `llm.models` are **servable** on this edge,
   not merely curated; whether app-data is provisioned and its `writesPerDay` /
   `bytesPerDay` baselines; the named **connections** available to reference from
   `fetch.origins`, each with the origin it fronts; whether `externalOrigins` is
   permitted at all; that `mcp` is carried but unenforced (no transport exists);
   `offline` availability and its scope rule; the deploy caps; the dev-gateway base;
   and the four approval baselines with the elevated-vs-baseline rule.

3. **The catalogue's job is to predict approvals.** The most useful thing it carries
   is not the capability list but which requests **auto-approve**. ADR-0016's
   classifier queues any `externalOrigins` entry, any `fetch.origins` entry, any
   `mcp` server, `public` visibility, or any budget above a baseline. An agent that
   reads the thresholds first can design an app that ships immediately instead of
   one that stalls on a human. This is the reason the endpoint is instance-wide
   rather than per-app: it is a menu of what is *requestable*, not a report of what
   some app already holds.

4. **`GET /api/v1/skill` — the same catalogue, rendered.** `text/markdown`,
   `renderSkill()` server-side with `vars` derived from the catalogue. The SPA drops
   its client-side `?raw` render and fetches this, which closes the curated-vs-
   servable gap at its source rather than in the modal. `helix skill` writes it into
   the app directory — the consumer `index.ts` already names.

5. **Both endpoints sit behind the existing bearer chain**
   ([ADR-0024](0024-portal-cli-bearer-jwt-jwks.md)), like every other `/api/v1` read.
   The disclosure that justifies it is the connection catalogue: names and fronted
   origins leak vendor relationships and internal service names. No secret *value* is
   ever in the response, so this is nowhere near `app_secrets` territory and needs no
   new role or grant. `GET /api/v1/config` stays public and unchanged — it is the
   pre-sign-in bootstrap, and its comment is right that the topology it carries "is
   the same topology any visitor reads off an app URL."

6. **The four baselines become template vars.** `{{BASELINE_DOLLARS_PER_DAY}}` and
   friends replace the literal numbers in `SKILL.md` §2, fed from the catalogue. They
   remain sourced from the `@azx-pbc/shared` constants until something makes them
   per-deployment configurable; the point is that the seam exists before it is
   needed, and the placeholder test guards it.

7. **The public site is deployment-agnostic, and never states an instance value.**
   It documents the platform model, the CSP, the manifest schema, the `/_api/*`
   contracts, and the CLI, and points readers at their own deployment's
   `/api/v1/capabilities` for values. `docs/features/` stays in the repo and off the
   site — it is contributor orientation, written against file paths and handler
   names. Publishing `docs/adr/` alongside the site is permitted and encouraged as a
   clearly secondary section; `docs/reviews/`, `TODO.md`, and
   `platform-project-plan.md` are not published.

## Consequences

- **The instance-specific surface is now enumerated in one place** rather than
  implied by which `{{PLACEHOLDER}}`s happen to exist. `SkillVars` was already that
  list informally; the catalogue makes it a typed, validated response with a zod
  schema in `@azx-pbc/shared` like every other boundary.
- **The curated-vs-servable distinction becomes visible to apps.** Deriving
  `llm.models` from what the edge can actually route means a deployment that never
  seeded the `openai` secret stops advertising `gpt-*` in its skill. This changes an
  app-visible fact, so the catalogue's model list must agree with
  `RoutingLlmProvider.supports()` or the 503 pre-check reappears at call time — one
  source, or the drift moves rather than closing.
- **The SPA loses its offline render.** `HelpModal` currently produces a skill from
  the bundle plus `/api/v1/config` alone; after this it needs an authed fetch. The
  existing null-guard pattern (buttons disabled until config lands) extends to the
  new request, so a failed fetch shows an error rather than a skill with a
  placeholder host still in it.
- **Two documents must agree, and only one is authored.** The public site includes
  regions of `SKILL.md` rather than restating them, so the drift risk sits in the
  include boundaries, not in the prose. A section renamed in `SKILL.md` breaks the
  site build — noisy, which is the desired failure.
- **Connection names are a real, if small, disclosure, and it took effect.**
  Any authenticated portal principal now learns which `global`-scope connections
  this deployment has provisioned, via `GET /api/v1/capabilities` behind the
  ADR-0024 bearer chain (not `requireAdmin`). That is a deliberate widening from
  the prior state, where connections were visible only via `/api/v1/secrets` to
  an admin. The catalogue sits at the same trust level as every other `/api/v1`
  read, consistent with decision 5; revisit if per-app RBAC
  ([ADR-0007](0007-portal-authz-v0.md)) lands and portal reads stop implying
  platform-wide trust.
- **The approval-prediction payload is agent-facing, with no platform-side
  consumer yet.** `approval.elevationTriggers` + `approval.baselines` are the
  catalogue's most useful payload (decision 3), but neither the SPA nor the CLI
  renders "design an app that auto-approves" guidance from them today — the
  value is for an agent or tool reading the JSON directly. Catalogue-driven
  manifest validation in the CLI (the natural platform-side consumer) is
  deferred.
- **Deferred:** per-app catalogue projection (what *this* app has been granted, useful
  to an agent iterating on an existing app), catalogue-driven manifest validation in
  the CLI, any machine-readable capability description for
  [ADR-0031](0031-connection-providers-delegated-auth.md)'s delegated-auth providers,
  and the public docs site (decision 7). Each is additive behind the same endpoint
  or behind `renderSkillGeneric()`.
