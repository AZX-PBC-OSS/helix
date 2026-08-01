# 0032. CLI naming (`helix`) and distribution (public npm, bundled)

**Status:** Accepted _(2026-07-30)_
**Related:** `packages/cli/README.md`; `docs/features/cli.md`; ADR [0024](0024-portal-cli-bearer-jwt-jwks.md) (CLI auth); `packages/cli/scripts/build.mjs`, `.github/workflows/ci.yml`

## Context

The deploy CLI shipped in M1 as `@azx-pbc/cli`, binary `azx`. Two problems surfaced together.

**The name overreaches.** AZX is the *company*; Helix is *one product*. Claiming the bare `azx` binary for Helix's deploy tool spends the company namespace on a single product — anything else AZX ships would have to work around it. The repo had already drifted the other way without a decision behind it: the root package is `helix`, CI pushes `helix-edge`/`helix-portal`/`helix-egress` images, and the DB roles are `helix_edge`/`helix_egress`. Only the CLI's user-facing surface and the docs prose still said `azx`.

**The package was unpublishable, and that was invisible.** `private: true`, `version: 0.0.0`, `noEmit: true` inherited from `tsconfig.base.json`, and `bin` pointing at `./src/bin.ts` behind a `#!/usr/bin/env -S tsx` shebang while `tsx` was only a devDependency — a global install would have failed on arrival. Worse, `@azx-pbc/shared` is a private `workspace:*` dep that exports raw TS from `./src`, so `pnpm publish` would have rewritten it to `@azx-pbc/shared@0.0.0`, a version no registry has. Nothing in CI would have caught any of it: the unit tests never touch a packaged artifact.

GitHub Packages was the proposed registry. It is a real option, but a poor one here.

## Decision

**The binary is `helix`. The package is `@azx-pbc/helix-cli`.** The bin name is independent of the package name, so the company scope stays on the package (where it is accurate) and the product name goes on the command (where users type it). Unscoped `helix` and `helix-cli` are both taken on npm; the scope was needed regardless.

Renamed with it, since they are the same user-facing surface: the config file `azx.json` → `helix.json`, the env vars `AZX_TOKEN`/`AZX_PORTAL_URL` → `HELIX_TOKEN`/`HELIX_PORTAL_URL` (matching the `HELIX_*` prefix infra already uses), and the token cache `~/.config/azx/` → `~/.config/helix/`. The config file and env vars keep a **dual read** with the old names as fallback; the new names win. The token cache does not — `readFileTolerant` already treats a missing file as logged out, so the worst case is one `helix login`.

**Explicitly not renamed:** the `azx-cli` OIDC client_id and the `azx-egress` attested-instruction audience. Those are wire identifiers that must stay in sync with the Entra app registrations and a deployed egress; changing them is a coordinated config-and-deploy change, not a rename. The `azx` wordmark in the portal and login chrome is the company brand and is correct as-is.

**Distribution is public npm, not GitHub Packages.** GitHub Packages requires the npm scope to match the owning org — `@azx-pbc-oss/…`, not `@azx-pbc/…` — and requires an authenticated token to install *even for public packages*. For a CLI whose whole point is `npm i -g`, forcing every consumer to provision a PAT and write an `.npmrc` is a real adoption tax that public npm does not impose.

**The build is an esbuild bundle**, not `tsc --outDir`: `scripts/build.mjs` emits a single `dist/helix.js` with a `#!/usr/bin/env node` banner, inlining `@azx-pbc/shared` and keeping `archiver`/`openid-client`/`zod` external. `shared` moves to a devDependency of the CLI.

**Publishing is deferred to M5**, but everything up to it ships now. CI gains a `package` job that builds, packs, asserts the tarball contents, and globally installs the tarball with `tsx` off `PATH` before running `helix --help`.

## Consequences

- The company namespace stays free for whatever AZX ships next; `helix` reads correctly as a product command.
- **`@azx-pbc/shared` stays build-free.** Bundling was chosen precisely so publishing one package does not force a dist + `.d.ts` + non-`src` exports onto a package that four services deliberately consume as raw TS. The cost is that the CLI's copy of `shared` is a build-time snapshot — a `shared` change requires a CLI rebuild, which the `package` job does from scratch every run.
- The CLI is now the **only package in the repo that emits JS**, and the only non-`private` one. `noEmit: true` stays global; esbuild does the emit and `tsc` remains a pure typechecker.
- **Publishability is now a tested property, not an assumption.** The global-install smoke test is what catches a broken shebang, a missed external, or a `tsx`-at-runtime regression — none of which the unit suite can see. That gap is exactly how the pre-rename package came to be unpublishable without anyone noticing.
- Dual-reading `AZX_*` and `azx.json` is deliberate but is **transition scaffolding, not a contract**. It should be dropped at the first minor version after M5; leaving it indefinitely re-establishes the name we just retired.
- Choosing public npm means a real publish identity to manage. Trusted publishing (OIDC) keeps that to a repo-scoped trust relationship rather than a long-lived `NPM_TOKEN` in secrets.
- Docs prose for the three services was aligned to `helix-edge`/`helix-portal`/`helix-egress` in the same pass, matching the image names and DB roles. The `aud: "azx-egress"` literal was excluded — it is a verified claim, not prose.

## Amendment (2026-07-31) — publishing landed

The deferred half of the decision shipped. Four details were settled in the doing, none of which change the decision above:

**A hand-published `0.0.0` placeholder exists, and that is not an accident.** npm cannot attach a trusted publisher to a package that does not exist yet ([npm/cli#8544](https://github.com/npm/cli/issues/8544) is open; PyPI allows pre-registration, npm does not), so OIDC can never perform a package's *first* publish. The choice was between hand-publishing the real `0.1.0` — leaving exactly one released version with no provenance attestation — or burning `0.0.0` on an empty placeholder so that every version anyone actually installs is CI-built and attested. We took the second. `0.0.0` is deprecated on the registry and its README says what it is. The name `@azx-pbc/helix-cli` and the version string `0.0.0` are now permanently claimed either way.

**Releases are cut on `cli-v*`, not `v*`.** The original sketch reused the existing `tags: ["v*"]` trigger. That was wrong: `v*` is the *platform's* version and already drives the three container-image builds, so reusing it would force a CLI release on every platform release and vice versa. `cli-v*` versions the CLI independently and does not match `v*`.

**`release-cli.yml` is a separate workflow, deliberately not a job in `ci.yml` and not a reusable workflow.** npm matches the OIDC `workflow_ref` claim against the exact filename registered as the trusted publisher, so a dedicated file makes the grant narrow — no other workflow in the repo can mint a publish, and widening CI cannot silently widen publish rights. A reusable workflow would move the claim to `job_workflow_ref` and complicate the match. The cost is that the build → pack → assert → global-install sequence is duplicated from `ci.yml`'s `package` job; that duplication is wanted, because the release must prove the exact bytes it is about to publish rather than trust an earlier run.

**It packs with pnpm and publishes with npm.** Only pnpm rewrites `catalog:`/`workspace:*` into real semver, but pnpm's OIDC support has been unreliable on the 11.x line ([pnpm#11513](https://github.com/pnpm/pnpm/issues/11513) — trusted publishing 404s on pnpm 11 where it worked on 10), and this repo pins `pnpm@11.5.3`. So `pnpm pack` produces the tarball and `npm publish <tarball> --provenance` ships it. A CI step asserts the packed manifest carries no surviving `catalog:`/`workspace:` specifier, because that failure is registry-visible and permanent. `--provenance` is passed explicitly rather than relying on trusted publishing's implicit default, and is deliberately *not* set in `publishConfig`, so an emergency hand-publish doesn't fail on "provenance requires CI".

Consequence worth tracking: publishing starts the clock on the `AZX_*` / `azx.json` dual-read above, which this ADR already called transition scaffolding to drop at the first minor version after M5.
