# Git connections (deploy-from-repo)

**Status: design, not built.** Scoped out of M1–M4.5 deliberately — the deploy
path today is upload-only (`azx deploy` zips a build dir, or the portal takes a
multipart zip; architecture §5). This doc proposes the missing rung: **connect a
git repo, and on push the platform clones, builds, and lands a preview version**
— without standing up a build farm and without putting a git credential in reach
of the code being built. Doc is Claude-written, human reviewed, but probably not
quite ready to execute on.

## 1. The framing that makes this tractable

A git build is **the first place Helix runs untrusted code _server-side_.**

Everything the platform hosts today is untrusted (the founding stance,
architecture §1) — but a hosted app is static assets + browser JS + the `/_api/*`
gateway. None of the *app's* code executes on our infrastructure; the edge only
serves bytes and the browser runs them inside the §4.4 CSP. A build is
categorically different: `npm install` runs dependency `postinstall` scripts and
the build script runs arbitrary code, **on our compute, with whatever it can
reach.** Building vibe-coded apps is remote code execution by design.

So we don't model this as "CI we need to harden." We model it as a **fourth
untrusted execution zone**, and we wire it with the seams the platform already
has rather than inventing a new trust model:

- the **policy/mechanism split** (edge→egress, architecture §3) — the thing that
  holds the secret is never the thing that runs untrusted code;
- the **`SecretStore` custody seam** (`@azx-pbc/secret-store`) — where the git
  credential of record lives, unreadable by the build;
- the **preview-then-promote deploy gate** (architecture §5.1,
  `docs/features/registry-and-deploys.md`) — the build's output rejoins the
  *existing* validated path; it does not get a privileged shortcut.

The two ways this feature goes wrong, and the two design moves that prevent them:

| Failure mode | Prevented by |
| --- | --- |
| Malicious build code / dependency exfiltrates the git credential | **Credential never enters the build zone** (§3) |
| Owning a pool of warm, reset-between-builds nodes becomes ops hell | **Ephemeral-by-construction**: one container per build, destroyed after (§4) |

## 2. Scope

**In scope.** Bind a GitHub repo (GitHub App; GitLab/Bitbucket later) to an app.
On push to the tracked branch, clone, run a declared build, and submit the output
to the portal deploy API as a **preview** version. The owner promotes as today.

**Out of scope (explicitly).**
- _Letting **running** apps read private repos at runtime_ — that's a fetch-proxy
  connection (`docs/design/fetch-proxy.md`), not this.
- Monorepo multi-app fan-out, build matrices, caching layers — a later rung.
- PR preview environments — needs ephemeral subdomains; defer.

## 3. The credential never enters the build

This is the whole security argument; everything else is mechanics.

The dangerous coupling is not "we run a build" — it is "we run untrusted code
*next to a git credential*." A dependency's `postinstall` can read the
environment, the filesystem, and `~/.git-credentials` in milliseconds. So we
split the clone from the build exactly like the edge splits authz from egress:

1. **Store a GitHub App private key**, not a PAT or a deploy key, in the existing
   `SecretStore` seam (dev AES-GCM envelope / prod Key Vault — `secret-store`,
   `docs/design/secrets-and-connections.md`). One app-level credential of record,
   sealed where egress secrets live, **with no `helix_edge` grant** — the policy
   edge cannot read it, same as connection secrets.
2. **A privileged fetcher** (mechanism zone — sibling of `azx-egress`, see §5)
   mints a **short-lived installation token** (GitHub App installation tokens are
   ~1 h and repo-scoped), clones with it, and discards it.
3. The fetcher hands the build container a **credential-less checkout** — a
   tarball of the working tree on a read-only mount, or a local bare mirror. The
   `.git/config` carries no remote credential; `~/.gitconfig` and any credential
   helper are absent in the build environment.

So the build never sees a secret. The worst a compromised build can do with
"git" is read *the customer's own source it was handed* — which they already own.
And because the stored credential is a GitHub App key rather than a broad PAT,
even a leak at the fetcher step is repo-scoped and expires in an hour.

> **Why a GitHub App over a deploy key / PAT.** Installation tokens are
> short-lived, narrowly scoped, and centrally revocable; the binding (which repos
> an installation may touch) is managed on GitHub's side, not by us minting
> long-lived secrets we then have to rotate. The private key is one secret in the
> store; everything downstream is ephemeral. This mirrors the fetch-proxy
> preference for injected, server-side, never-app-held credentials.

## 4. The build is ephemeral by construction

The instinct to "restart / clear the container between builds" is right, but
clearing is a correctness burden you own forever: a build that escapes its work
dir, leaves a daemon, or poisons a cache persists into the *next* tenant's build,
and a warm container holding any standing credential is a fat, long-lived target.
So we go one step further than reset — we **destroy.**

**One container per build; it does exactly one build and exits.** Ephemerality is
the default state, not something a cron job maintains.

- **Runtime: Azure Container Instances (one-shot) or Container Apps Jobs**
  (KEDA-driven, scale-to-zero). This is the answer to the ops-hell worry: no
  pool, no warm nodes, no hygiene sweep, no reset logic to get wrong. Pay per
  build-second. For the low volume we expect, this is the sweet spot —
  cold-start (seconds) is irrelevant for a build. (Architecture §8 Azure mapping;
  this slots in as a job runner alongside the container apps.)
- **Lock the box down** regardless of runtime: non-root, read-only rootfs +
  `tmpfs` work dir, `seccomp` default + `no-new-privileges`, CPU/memory caps, and
  a **hard wall-clock timeout** (a hung or mining build is killed, not babysat).
- **`npm install --ignore-scripts` as the default** — it kills the primary RCE/
  exfil vector (lifecycle scripts). Make it an explicit per-app opt-out for apps
  that genuinely need a native build step, surfaced like any above-baseline
  capability (it widens the blast radius, so it routes through the approval
  write-gate, `docs/design/approvals.md`).
- **Outbound network**: the build needs the package registry. For v1, open
  outbound is *acceptable* — the only sensitive material in the box is the
  customer's own source, and there is no secret to exfiltrate (§3). We do **not**
  need egress-grade SSRF controls here, which is a large simplification. When
  untrusted native builds with private registries arrive, tighten to an allowlist
  proxy (and reuse egress's posture) — `log()` the relaxation until then so it is
  never mistaken for "locked down."

## 5. Wiring, end to end

The control-plane / mechanism split mirrors edge→egress: webhook verification and
job orchestration live in the **portal (control plane)**; the secret-bearing
clone and the untrusted build live in the **mechanism zone**.

```
GitHub push ─▶ webhook ─▶ azx-portal                         control plane
                          • verify webhook HMAC (X-Hub-Signature-256)
                          • match installation + tracked branch
                          • enqueue a build job
                                  │
                                  ▼
                          fetcher (mechanism zone)            holds the secret
                          • mint short-lived installation token from the
                            stored GitHub App key (SecretStore / helix_egress-class role)
                          • clone, produce credential-less checkout
                                  │  read-only checkout, no credential
                                  ▼
                          build job (ACI / Container Apps Job) untrusted exec zone
                          • one-shot, sandboxed, --ignore-scripts default
                          • run declared build → emit artifact (static assets + manifest)
                                  │  same artifact `azx deploy` produces
                                  ▼
                          azx-portal deploy API ─▶ preview version  existing gate
                          • validate.ts (zip-slip, MIME, decompression bomb)
                          • csp-lint advisory • manifest approval write-gate
                          • lands as `preview`; owner promotes (architecture §5.1)
```

**The output rejoins the existing path — it gets no shortcut.** The build emits
**the same artifact `azx deploy` already produces** (a zip of static assets + the
capability manifest) and POSTs it to `POST /api/v1/apps/:slug/versions` with a
scoped build token. It does **not** write the registry, the live pointer, or Blob
directly. So it inherits every existing protection for nothing: `validate.ts`
(zip-slip, symlink, MIME, decompression-bomb defenses), the non-blocking CSP
lint, the manifest approval write-gate, and preview-then-promote. **The worst a
compromised build achieves is submitting a malicious _preview_ version** — a
threat the deploy pipeline is already built to contain, inspected by a human
before it can take traffic.

### Where the orchestrator lives

A thin **build orchestrator** owns the webhook endpoint, the job queue, and
launching/reaping the one-shot containers. It is control-plane-adjacent (it must
talk to GitHub and to the deploy API) but it is the component that *holds the
GitHub App key path* and mints installation tokens, so it belongs in the
mechanism zone with its own managed identity — the same reasoning that made
egress its own deployable from day one (architecture §3, fetch-proxy design §"why
a separate plane"). Whether it is folded into `azx-egress` or a new
`apps/build-orchestrator` is an implementation call (§9); the trust boundary is
the fixed part.

## 6. Schema sketch (portal-owned, as always)

The portal owns every write (architecture §7). New tables, migrated via Prisma:

- **`git_connections`** — `(appId, provider, installationId, repoFullName,
  trackedBranch, buildCommand, outputDir, ignoreScripts)`. The GitHub App private
  key is **not** here — it is one platform-level secret in the `SecretStore`;
  `installationId` is the non-secret pointer used to mint tokens.
- **`builds`** — `(id, appId, connectionId, commitSha, status, startedAt,
  finishedAt, logBlobPrefix, resultingVersionId?)`. Status:
  `queued | cloning | building | uploaded | promoted | failed | timed_out`.
  Build logs stream to Blob (untrusted output — never interpolated into the
  portal UI unescaped).

Each transition writes an `audit_events` row (`build.start`, `build.fail`,
`build.upload`, …) like every other mutation.

## 7. Threat model (abridged — extends architecture §10)

| Threat | Mitigation |
| --- | --- |
| Malicious dependency `postinstall` exfiltrates a credential | No credential in the build zone (§3); `--ignore-scripts` default (§4) |
| Build escapes its work dir into the next build | One-shot container, destroyed after — no shared/reset surface (§4) |
| Crypto-miner / fork-bomb / hung build | CPU/mem caps + hard wall-clock timeout; killed, not babysat (§4) |
| Stolen/leaked clone credential | GitHub App installation token: ~1 h TTL, repo-scoped, revocable (§3) |
| Build writes a malicious version live, skipping review | Build can only submit a **preview**; promote stays a separate human step (§5) |
| Forged / replayed webhook triggers builds | HMAC-verify `X-Hub-Signature-256` against the per-app webhook secret; reject otherwise (§5) |
| Build log injection into the portal UI (stored XSS) | Logs are untrusted bytes — stored in Blob, escaped on render (§6) |
| Source exfiltration via open build egress | Accepted for v1: the only data present is the customer's own source; tighten when private registries / native builds land (§4) |

**Honest limits.** The fetcher still holds a path to the GitHub App key and a
brief plaintext installation token — extraction *relocates* that exposure into
the mechanism zone (its own identity, its own network zone), it does not
eliminate it, exactly as the fetch-proxy design notes for egress and the vault
grant. And open build egress means a determined build can phone home with the
source it was handed; that is the customer's own code, so the trade is
deliberate, but it is logged, not silent.

## 8. Phasing

1. **M-git.1 — clone + build + preview, no secrets.** Public repos only, no
   credential, one-shot ACI/Job, `--ignore-scripts`, output → preview via the
   existing deploy API. Proves the execution zone and the output gate end to end.
2. **M-git.2 — GitHub App + private repos.** Store the App key in `SecretStore`,
   the fetcher mints installation tokens, credential-less checkout. Webhook HMAC.
3. **M-git.3 — portal UX.** Connect-repo flow in `apps/portal-web` (Capabilities
   or a new Deploy tab), build history + streamed logs, manual "build now."
4. **Later.** GitLab/Bitbucket providers; opt-in native builds behind approval;
   build caching; PR preview environments.

## 9. Open questions

- **Orchestrator home** — fold the webhook/queue/runner into `azx-egress`
  (shares the mechanism zone + a managed identity) or stand up
  `apps/build-orchestrator`? Leaning separate: egress is request/response-shaped
  and dependency-minimal; a job runner has a different lifecycle.
- **Job runtime** — ACI one-shot vs Container Apps Jobs. Jobs give nicer
  queueing/scale-to-zero if bursts appear; ACI is the simplest one-shot. Decide
  against real launch latency + cost numbers.
- **`--ignore-scripts` default** — confirm how many real vibe-coded apps break.
  If most need it off, the opt-out → approval flow becomes the common path and we
  should make it frictionless.
- **Build determinism / lockfiles** — require a committed lockfile? Pin the
  toolchain image? Affects reproducibility and supply-chain surface.
- **Concurrency + cost ceiling** — per-app build concurrency cap and a
  platform-wide max-in-flight, so a push storm can't fan out unbounded paid
  containers.

## 10. Related

- `docs/design/fetch-proxy.md` — the policy/mechanism split this reuses, and the
  attested-instruction primitives if the fetcher↔orchestrator call needs signing.
- `docs/design/secrets-and-connections.md` — the `SecretStore` custody seam the
  GitHub App key lives in.
- `docs/features/registry-and-deploys.md` — the preview-then-promote deploy gate
  the build output rejoins.
- architecture §3 (three planes / why a separate deployable), §5.1 (deploy),
  §10 (threat model).
