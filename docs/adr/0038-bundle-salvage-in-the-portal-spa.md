# ADR-0038 — Malformed upload bundles: salvage in the portal SPA, contract unchanged

## Status

Accepted — reviewed and agreed; implementation not yet started. Relates to
[ADR-0018](0018-deploy-model-immutable-versions.md) (the deploy model whose "upload a zip of
static files" contract this deliberately does not change),
[ADR-0026](0026-hosted-build-isolation-prerequisites.md) and
[ADR-0030](0030-repo-backed-apps-pull-attested-artifacts.md) (why the platform does not
build app code, and what eventually removes the need for a human to assemble an archive at
all), [ADR-0035](0035-offline-capability-platform-service-worker.md) (the one path prefix
the platform supports, which this decision refuses to generalise),
[ADR-0016](0016-capability-manifest-approval-classifier.md) (a `manifest.json` found inside
an uploaded bundle is not a grant path) and [ADR-0007](0007-portal-authz-v0.md) (the deploy
report added here is client-asserted, and is treated as such).

The offline-scope behaviour in decision 11 — pin the root to the granted scope, and offer to
nest a mismatched bundle when the reference graph proves it safe — was the one item decided
separately from the framing.

## Context

Users who are not developers are told: _upload the contents of your `dist` directory in a
zip_. They send almost everything but — the whole project root, the build folder wrapped
inside itself, a randomly-named folder with the contents inside, occasionally a zip of a
zip. Two of the real ones are committed as fixtures
(`apps/portal/src/deploy/fixtures/`, reconstructed with the content stubbed out), and
between them they show the failure has two opposite faces.

**`PROJECT_ROOT_MACOS` — the loud wrong answer.** 26 entries: 10 files, 3 directory
records, 13 macOS `__MACOSX` sidecars. It fails at **entry #2 of 26** on
`__MACOSX/._helix-app` (`apps/portal/src/deploy/validate.ts:119`), so the message a
non-technical user reads is `file type not allowed (static files only):
__MACOSX/._helix-app` — metadata they never created, in a directory they have never seen.
Three entries later sits a `helix.json` declaring `dir: "dist"`. **The archive is carrying
the answer and we reject it before reading it.** Two further properties of that fixture
matter for anything we build: its `src/` and `dist/` trees are **byte-identical**, because
the "build" is `cp src/{index.html,styles.css,app.js} dist/` — which is the normal shape for
a vibe-coded app with no bundler, so content-based discrimination between candidate roots
is not merely hard here, it is structurally unavailable for the population we are serving.
And the junk is interleaved from entry #2 onward, so **any** error that reports the first
offending entry will report junk before it reports anything true.

**`WRAPPER_DIR` — the silent wrong answer, which is worse.** 8 files, no junk, a correct
multi-page static site one directory too deep. Every extension is on the mime allowlist, so
it **validates, deploys green, and then serves a 404 at `/`**. The only signal is the
advisory at `validate.ts:155`, rendered as one line in the same list as CSP origin
warnings; the fixture keeps an allowlisted CDN origin (`fonts.googleapis.com`) precisely to
preserve the real conditions, in which that advisory arrives with nothing beside it. A
success followed by a dead app is a worse onboarding experience than a rejection, and it is
also the shape that most resembles a correct offline bundle.

There is a security argument alongside the ergonomic one. Had the project-root fixture been
accepted at its own root, `package.json`, `build.mjs`, `manifest.json` — which enumerates
the app's grants and spend caps — and every file under `src/` would all have been served
from the app origin, because every one of those extensions is on the allowlist
(`apps/portal/src/deploy/mime.ts`). **Choosing a root is a confidentiality control, not only
a convenience.**

Three facts about where this can be fixed shaped the decision.

1. **The SPA is the only place a human assembles an archive by hand.** `SKILL.md:351`
   teaches agents `helix deploy`, and the CLI zips a directory's *contents*
   (`packages/cli/src/zip.ts:11` — `archive.directory(dir, false)`), so it is correct by
   construction. Fixing one hand-assembly path beats teaching every producer.
2. **A server-side fix has a structural hazard the client-side fix does not have.**
   Validation and blob upload are two independent passes over the same zip that re-derive
   each entry's path from its name (`validate.ts:105`, `upload.ts:127`). Re-rooting makes
   the path mapping a function of the *whole* entry set rather than of one name, so the
   server would have to emit a plan from the first pass and have the second consume it —
   and any disagreement between them means blob keys silently diverging from what was
   validated. Doing the work before the upload deletes that hazard instead of managing it.
3. **The client already has the two pieces of context it needs.** The zip often carries its
   own `helix.json`, and the SPA already fetches the app's manifest
   (`apps/portal-web/src/api/queries.ts:76`) — so the app's offline scope, the one
   legitimate reason a bundle is nested, is available with no new endpoint.

This is a stopgap and should be read as one. [ADR-0030](0030-repo-backed-apps-pull-attested-artifacts.md)
— repo-backed apps pulling CI-built attested artifacts — is the real answer to "a human
should not be assembling an archive". If it lands broadly, most of what follows becomes
vestigial, and that is an acceptable outcome for work whose whole purpose is to stop
punishing users for a step we would rather delete.

## Decision

1. **Salvage is a `apps/portal-web` responsibility, and the upload contract does not
   change.** The zip that reaches `POST /api/v1/apps/:slug/versions` always carries the
   contents of a build directory at its root. There is no `root` parameter, no server-side
   re-rooting, and no second interpretation of an archive between validation and blob
   upload. The CLI keeps producing exactly what it produces today, and we hold CLI users to
   the current expectation deliberately.

2. **The planner is a pure function, and it lives in `@azx-pbc/shared/bundlePlan`.**
   `planBundle(entries, ctx)` takes `{path, bytes}[]` plus optional app context and returns
   a `BundlePlan`. No I/O, no zip library, no browser API, no new dependency — `shared`
   stays zod-only. That placement is what lets the SPA decide, the portal explain (decision
   9), and the CLI warn later, from one implementation and one fixture corpus, with subpath
   exports already established there (`./bodyCap`, `./devToken`, `./logging`).

3. **Root detection is a weighted signal table, not a chain of conditions.** Each signal is
   a row — `{ id, weight, authoritative?, evaluate(candidate, tree) }` — returning a score
   and a `because` string, or nothing when it has no opinion. Candidate roots are every
   directory plus the archive root; the plan is the highest scorer. The initial rows:
   `declaredBuildDir` (a `helix.json` / `azx.json` `dir`, authoritative), `singleWrapper`,
   `buildDirName` (`dist`, `build`, `out`, `public`, `_site`, `.output/public`),
   `hasIndexHtml`, `referencesResolve` (decision 6), `hashedAssets`, and the negatives
   `projectArtifacts` (`package.json`, `node_modules/`, `vite.config.*`, `.git/`),
   `sourceExtensions` and `serveableShare`.

   The `because` string is the same text the confirm step renders. **Showing the user our
   assumptions is a byproduct of the scoring, not a parallel body of prose that can drift
   from it**, and supporting a newly-observed shape means adding a row and a test.

4. **A perfect zip gets no gate; anything else is confirmed by the user.** The plan's
   outcome is one of `canonical` (the plan is the identity — upload the user's original file
   untouched, no re-zip), `rerooted`, `ambiguous` (the top two candidates are too close to
   call, or the layout conflicts with the app's configuration) or `unsalvageable`. Only
   `canonical` skips the flow. Any re-rooting, any dropped file, any junk inside the chosen
   root, any unresolved local reference means the user sees what we intend to do and can
   change it.

   **Ambiguity is a first-class outcome, not a fallback.** With `helix.json` absent, the
   project-root fixture has no honest automatic answer, and copy-builds make that common
   rather than exotic. An `ambiguous` plan presents the ranked candidates with their
   evidence and requires a choice.

5. **Junk is dropped, never served, and always costs one confirmation.** `__MACOSX/`,
   AppleDouble `._*`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.git/`, `node_modules/` and
   `.env*` are dropped before anything is counted — which also keeps a `node_modules` zip
   from tripping a size cap and reporting a size problem instead of the real one. Junk
   *inside the chosen root* is enough on its own to require the confirm step: a stray
   `.DS_Store` costs a click, and in exchange no upload is ever silently rewritten. `.env*`
   is called out loudly — dropped client-side, so the secret never leaves the machine, with
   the advice to rotate anything that was in it.

6. **Local references are resolved, and a broken graph is both a signal and a warning.**
   For each HTML file under a candidate root, local `src` / `href` / `srcset` and CSS
   `url()` targets must resolve to an entry in that candidate. This feeds scoring — an
   unbuilt Vite template whose `index.html` points at `/src/main.tsx` scores negative
   against the same project's `dist/` — and is surfaced per file in the confirm step. It is
   the check that catches "deployed fine, blank page" in general, and it is honest about its
   limit: it cannot break the byte-identical `src`/`dist` tie, where every reference
   resolves under both.

7. **Leniency may drop files and re-root a tree; it may never widen what is served.** The
   mime allowlist stays deny-by-default and stays the server's
   (`apps/portal/src/deploy/mime.ts`). Files inside the chosen root whose type is not
   serveable are dropped **loudly**, because that is the new failure mode leniency
   introduces: an `.mp4` that used to fail the deploy now disappears from a deploy that
   succeeds. Whether the allowlist should grow to cover inert media is a real question and
   is deliberately **not** answered here.

8. **Folder drop is the primary path, and the guidance names the target.** The SPA accepts a
   dropped directory as well as a zip and builds the canonical archive itself, so "zip"
   leaves the onboarding vocabulary entirely for the users who struggle most with it. The
   copy stops describing the artifact by reference to the CLI ("what `helix deploy` would
   send") and names what to pick: **your build output folder — usually `dist/`, `build/` or
   `out/`**. Client-side assembly also means an unusable upload is diagnosed before a byte
   goes over the wire, rather than after a 30 MB round trip.

9. **The server gets better messages and no new rejections.** When validation already
   raises `bundle_invalid`, the portal enumerates the archive's entry names and declared
   sizes (no inflation — so no new decompression exposure, and declared sizes are used only
   for the message, never for policy), runs the same `planBundle`, and rewrites the error
   into a whole-archive diagnosis with the plan summary in `ApiError.details`
   (`packages/shared/src/api.ts:153`). The project-root fixture stops reporting a macOS
   sidecar and starts saying what the archive is and where its build appears to be.

   **What does not change: `validate.ts`, `mime.ts`, the limits, and every accept/reject
   outcome.** Diagnosis runs only on the failure path, so the happy path pays nothing and
   the security-critical streaming pass is untouched. A wrapper-directory zip from `curl`
   still returns 201 — see the consequences.

10. **What the SPA did is recorded on the version row.** A schema-validated, size-capped
    report (planner version, outcome, chosen root, file count, drop counts by reason,
    candidates considered) travels as a form field beside the bundle and is stored as
    client-asserted provenance. It is **never** consulted for policy, serving or
    authorization, and an invalid or absent report is ignored rather than failing a deploy.
    Its job is to answer "why does this version's file list look like this", which today is
    unanswerable, and to tell us which malformed shapes real users actually produce instead
    of leaving us to guess at the next signal row.

11. **Path prefixes are not a platform feature, but the one prefix that exists is handled.**
    The only supported prefix is an offline app's service-worker scope
    ([ADR-0035](0035-offline-capability-platform-service-worker.md)), where the bundle
    legitimately nests under the granted scope (`docs/features/edge-serving.md`, and
    `outDir: "dist/app"` plus `base: "./"` in `examples/offline`). There is no general
    "deploy under a path" capability, and generalising prefixes is deferred until something
    asks for it.

    An offline grant therefore changes the planner's target: **the chosen root is the one
    where `{scope}index.html` lives**, not the one where `index.html` lives. Without that
    pin, a scope-blind planner damages a correct offline bundle in either of two ways — it
    prefers the scope directory itself as the root, because that is where the hashed assets
    and the resolving reference graph are while the archive root holds only a two-line
    redirect; or, for an app that ships no root redirect (legitimate — a scoped app's bare
    `/` simply 404s), it sees a lone top-level directory and strips it. Both lose the `app/`
    prefix and 404 every in-scope request.

    When the upload does **not** match the app's scope — a root-level build with nothing at
    `{scope}` — the planner offers to **nest the bundle under the scope**, but only when that
    is provably safe: nothing already exists at `{scope}`, and every local reference in the
    bundle resolves relatively. A root-absolute reference (`/assets/…`) breaks under nesting,
    and decision 6 is what detects it; those bundles fall back to `ambiguous` with an
    explanation and an upload-as-is option. Nesting is a re-rooting like any other, so it is
    never `canonical` and always confirmed (decision 4).

    **The planner moves files; it never authors them.** After nesting, the app's bare `/`
    404s until the author ships something there — the flow says so, and points at the
    two-line redirect in `examples/offline`, rather than generating one.

12. **The deploy skill always writes `helix.json`.** The project-root fixture was
    self-describing only because a CLI config file happened to be in the repo. Having
    `packages/deploy-skill/SKILL.md` emit `helix.json` with `dir` makes the one
    authoritative signal near-universal for agent-built apps, at approximately zero cost —
    the cheapest lever in this whole ADR, and the only one that improves detection by
    improving the input.

## Consequences

- **The silent-green case stays open for every non-SPA producer, and that is an accepted
  cost.** A wrapper-directory zip from `curl`, or a `helix.json` pointing at the wrong
  `dir`, still deploys successfully and still serves a 404. Decision 9 buys a better
  explanation of failures, not a new failure. The available fix — making a missing
  root-level `index.html` a hard, scope-aware `bundle_invalid` — is a behaviour tightening
  that would reject bundles which deploy today, so it is recorded in `TODO.md` as a decision
  to take on its own evidence rather than smuggled in here. Anyone reading a green deploy as
  proof the app works is still wrong.

- **A new class of data enters the registry: an unverifiable client claim.** The server
  cannot check the deploy report, because only the client saw the original upload. Bounding
  it (schema, size, ignore-on-invalid) and refusing it any role in policy or serving keeps
  the blast radius at "a misleading row in the UI", but the constraint is a rule someone
  must keep applying — the temptation to let a future feature branch on `report.outcome` is
  exactly how this decays.

- **Two places now encode what a canonical bundle is.** The client asserts what the server
  will accept, so a divergence shows up as a preview that promises a deploy the server then
  refuses. The mitigations are structural rather than diligent: one planner in `shared`,
  and the mime allowlist and size caps sourced from the server rather than copied. Moving
  `mime.ts` into `shared` is the obvious next step and is not taken here.

- **The SPA gains a real dependency and a memory ceiling.** Reading and rebuilding archives
  in the browser means an in-tab zip library and an input a tab can choke on. Deciding the
  plan from names and sizes alone, never inflating what the plan drops, and refusing
  oversized inputs up front are what keep the common bad case — a project zipped with
  `node_modules` — from becoming a hung tab instead of a clear message.

- **Dropping quietly is the failure mode we are introducing, and we should expect to hear
  about it.** Every prior deploy either shipped a file or failed loudly. Now a file can be
  absent from a successful deploy. Decision 5 and decision 7 answer that with volume — the
  confirm step and the report — but the first real complaint will most likely be an
  unsupported media type, which is the evidence the deferred allowlist question needs.

- **Offline apps are the one place the planner writes a prefix rather than removing one, and
  its safety rests entirely on the reference check.** Nesting is correct only for a bundle
  whose references are relative; decision 6 is what establishes that, so a weakness in the
  reference resolver becomes a wrong nest rather than a missed warning. The narrow
  precondition (nothing at `{scope}` already, no root-absolute local references) is what
  keeps it from touching a bundle that is already right, and every nest is confirmed by the
  user before upload.

- **Handling the scope in the planner accommodates a requirement we would rather delete.**
  `outDir: "dist/app"` exists because the edge maps a URL path literally onto a blob key.
  Resolving in-scope requests by stripping the scope prefix at the edge would remove the
  requirement outright — the `base`-alone trap, the nesting, and this whole branch of the
  planner with it. That is a change to ADR-0035's serving contract with its own consequences
  (two URLs for the same bytes, only one of them precached) and belongs in its own ADR. If
  the mismatch shape turns out to be common, that is the signal to write it, and this
  decision is the cheap thing to delete afterwards.

- **The fixtures are the test corpus, and two is not many.** They cover the two shapes we
  have evidence for. The report from decision 10 is what turns the next shapes from
  anecdote into a list, and until it has been collecting for a while, every signal weight
  in decision 3 is a considered guess. The signal table exists so that being wrong about
  one is a row edit and a test, not a refactor.

- **This work is scaffolding around a step we would rather remove.** If repo-backed apps
  (ADR-0030) become the normal path, the hand-assembled archive — and most of this ADR —
  becomes a legacy path for one-off uploads. Choosing the cheap, contained, deletable fix
  over a deeper one is the point, not an oversight.
