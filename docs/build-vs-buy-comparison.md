# Build vs. Buy — Why Helix, not an off-the-shelf platform

**Status:** Decision-support doc for the M4.5 design review · June 2026
**Audience:** design reviewers asking "why build this instead of using something that exists?"
**TL;DR:** The market has strong products for *each slice* of what Helix does — app
hosting, untrusted-code sandboxing, enterprise SSO, AI gateways, secret-injecting egress
proxies — but **none combines them into "host an untrusted, vibe-coded static app behind
enterprise SSO where the app never holds a secret and every LLM/data/third-party call goes
through one governed, audited choke point."** Buying would mean stitching 4–6 products
together and still hand-building the highest-risk glue (the OIDC handoff, per-app origin
isolation, the secret↔origin binding, the approval workflow). The differentiator isn't any
one capability — it's the **integration around a single trust stance** (`platform-architecture.md` §1–§3).
**But that verdict assumes the static-only bet holds — §5 lays out the genuine strategic fork
(thin apps + governed gateway vs. full-stack apps + microVM isolation), which the review should
decide first.**

---

## 1. What we are actually comparing against

Helix's goals (`platform-architecture.md` §2) are specific. To judge alternatives fairly we
evaluate every candidate against the same eight criteria — these are the things Helix treats
as non-negotiable, not a generic feature wishlist:

| # | Criterion | Why it's core to Helix |
|---|-----------|------------------------|
| C1 | **Treats the app as untrusted** — contain blast radius, don't verify code | The founding stance (§1). Everything else follows from it. |
| C2 | **Per-app isolation = a real security boundary** (separate browser origin per app) | Subdomains are "the single most important security decision" (§4.1). |
| C3 | **Enterprise SSO terminated *by the platform*** — apps never implement auth | Apps are vibe-coded; auth they write can't be trusted (§4.2). |
| C4 | **Apps never hold secrets** — credentials injected server-side, out of app reach | A leaked/exfiltrated secret is the whole threat model (§3, §6.1). |
| C5 | **One governed gateway for LLM + data + third-party fetch** — quota, metering, audit | "Our main value add… the single choke point" (§1, §6). |
| C6 | **SSRF-hardened egress in its own network zone** | An app's outbound HTTP must not reach internal/IMDS targets (§3, egress plane). |
| C7 | **Self-hosted / portable, Azure-first** — we are customer #0 | Data residency + we run the control plane ourselves (§2 scope). |
| C8 | **Low ops for tens of apps, one org** | Not a multi-tenant SaaS business; an internal platform (§2). |

A candidate "wins" build-vs-buy only if it covers most of these *together*. Covering one or
two well is the normal case — and exactly why the market doesn't replace Helix.

---

## 2. The landscape, by category

The alternatives sort cleanly into five buckets. Each bucket nails a slice and structurally
misses others.

### 2.1 AI app builders that also host (v0, Lovable, Bolt, Replit)

These are where the apps *come from* — and several will host what they build.

- **v0 (Vercel)** — frontend generation → one-click Vercel deploy.
- **Lovable** — generates a backend via Supabase (auth, schema, APIs); hosts on Lovable Cloud.
- **Bolt** — full frameworks, connects a DB, Google SSO, custom domains.
- **Replit** — cloud IDE + hosting; **Enterprise** adds SOC 2 Type 2, RBAC, SSO.

**Where they fall short for us:** the app **holds its own secrets and implements its own
auth** (Lovable literally generates the Supabase auth code) — the precise opposite of C3/C4.
The platform *trusts* the generated app rather than containing it (fails C1). There is no
central, cross-app governed gateway with quotas/audit over LLM **and** arbitrary third-party
calls (fails C5/C6). They're complementary to Helix — they're the *source* of the bundles
Helix hosts — not a substitute for it.

### 2.2 General PaaS / full-stack hosting (Northflank, Vercel, Fly, Render, Azure Container Apps)

The strongest "just host it well" option. **Northflank** is the closest in spirit: microVM
sandboxing (Kata/Firecracker/gVisor), SAML/OIDC SSO with group→role mapping, secret groups
injected at runtime, RBAC + per-identity audit, and BYOC into Azure/AWS/GCP/on-prem.

**Where they fall short for us:** they host **arbitrary containers/full-stack apps** — which
*expands* the untrusted surface Helix deliberately shrinks to static frontends (against the
grain of C1). Critically, **there is no LLM/AI gateway and no governed third-party fetch with
secret injection** (fails C5/C6): you still build the gateway, the "app never holds a secret"
model, the per-app SSO termination, and the approval workflow yourself. Northflank gives you
excellent *primitives and isolation*; Helix is the *opinionated assembly* of those primitives
around one trust stance. (We do, in fact, run on Azure Container Apps — §3 — so this category
is our substrate, not our competitor.)

### 2.3 Low-code / internal-app governance platforms (Superblocks, Retool, Power Apps, Mendix, OutSystems, ServiceNow)

The governance-first bucket — and the one whose *pitch* sounds most like ours. **Superblocks**
explicitly markets "a governed home for AI app sprawl": native SSO/SCIM, fine-grained RBAC,
audit over builds/queries/AI generations, AI-generation policies, BYO-inference.

**Where they fall short for us:** you build **inside their proprietary low-code runtime**, not
"upload an arbitrary vibe-coded React bundle." That breaks the core workflow (§2 non-goal:
no in-platform builder — apps come from Lovable/Cursor/Claude Code). The governance applies to
*their* sanctioned building blocks; it is **not** "treat an opaque third-party bundle as the
adversary and contain it" (fails C1/C2). Most are cloud-hosted SaaS with limited or no
self-host (mixed on C7). They govern *trusted* low-code; Helix governs *untrusted* arbitrary code.

### 2.4 AI gateways / LLM proxies (LiteLLM, Portkey, Kong AI Gateway, Cloudflare AI Gateway, OpenRouter)

These are exactly **one of Helix's three planes** — the LLM-proxy slice of `/_api/*` (§6.1).
Portkey/Kong bring enterprise SSO, RBAC, budgets, guardrails, audit; LiteLLM brings per-team
budgets; Cloudflare brings caching + rate limits.

**Where they fall short for us:** they proxy **model traffic only**. They don't host apps,
don't terminate app-user SSO, don't isolate apps from each other, and don't do
secret-injecting egress to *arbitrary* third-party APIs (fail C1–C4, C6). They're a candidate
for the *inside* of our LLM proxy, not a replacement for the platform. (Worth a follow-up:
should `apps/edge`'s `LlmProvider` seam wrap LiteLLM/Portkey instead of our hand-rolled
Anthropic SSE? That's a "buy a component," not "buy the platform," decision.)

### 2.5 Untrusted-code sandboxes + egress proxies (E2B, Modal, Cloudflare Workers for Platforms, Vercel Sandbox, Blaxel)

The bucket that takes "untrusted code" as seriously as we do. **Cloudflare Workers for
Platforms** runs each tenant in an isolated V8 isolate with an "untrusted by default" mode.
**E2B/Modal** run Firecracker microVMs. **Blaxel** notably does **proxy secret injection** so
credentials never touch agent code — conceptually our `azx-egress` (§3, C4/C6).

**Where they fall short for us:** these are **primitives, not a platform**. E2B (per 2026
comparisons) passes secrets as env vars *visible inside the sandbox* and needs you to operate
your own egress tunnel — the exact failure C4/C6 exist to prevent. Workers-for-Platforms gives
isolation but you still build SSO termination, the gateway, the secret↔origin binding, audit,
and the approval queue on top. You'd assemble the sandbox + an AI gateway + an egress proxy +
an SSO layer + a control-plane UI — i.e. rebuild Helix from parts, and own the integration risk.

---

## 3. Capability matrix

Coverage of the eight criteria. ● = covers it, ◐ = partial / with caveats, ○ = not its job.

| Candidate | C1 untrusted | C2 origin-isolation | C3 SSO terminated | C4 no-secrets-in-app | C5 governed gateway | C6 SSRF egress | C7 self-host | C8 low-ops |
|-----------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **Helix** | ● | ● | ● | ● | ● | ● | ● | ● |
| v0 / Lovable / Bolt | ○ | ◐ | ◐ | ○ | ○ | ○ | ○ | ● |
| Replit Enterprise | ◐ | ◐ | ● | ○ | ○ | ○ | ◐ | ● |
| Northflank | ● | ◐ | ● | ◐ | ○ | ◐ | ● | ◐ |
| Vercel / Fly / Render | ◐ | ◐ | ◐ | ◐ | ○ | ○ | ◐ | ● |
| Superblocks / Retool | ◐ | ◐ | ● | ◐ | ◐ | ○ | ◐ | ● |
| LiteLLM / Portkey / Kong | ○ | ○ | ◐ | ◐ | ◐ | ○ | ● | ◐ |
| Cloudflare W4P / E2B / Modal | ● | ● | ○ | ◐ | ○ | ◐ | ◐ | ◐ |
| Blaxel (egress + sandbox) | ● | ● | ○ | ● | ○ | ● | ◐ | ◐ |

**Read across, not down.** Plenty of products earn a ● in a column. **No row but Helix's is
all ● — and most aren't even close on the row as a whole.** The product doesn't exist because
the value is the *combination*, and the combination is opinionated to one threat model.

---

## 4. So what would "buy" actually look like?

The honest minimum to replicate Helix from off-the-shelf parts:

1. **Workers for Platforms / E2B** for per-tenant isolation (≈ C1/C2), *plus*
2. **Portkey or Kong AI Gateway** for the LLM proxy (≈ C5, model traffic only), *plus*
3. **Blaxel or a custom MITM egress proxy** for secret injection + SSRF (≈ C4/C6), *plus*
4. **An SSO/identity layer** terminated in front of every app (≈ C3), *plus*
5. **A control-plane app** for deploys, approvals, secret writes, audit UI (≈ everything in `azx-portal`).

And you would **still hand-build the riskiest parts yourself**, because no vendor sells them:

- the **central OIDC handoff** (Entra has no wildcard redirect URIs — §4.2; "the most
  security-sensitive code in the platform"),
- **per-app browser-origin isolation** on a dedicated apps domain + PSL submission (§4.1),
- the **secret↔proxied-origin binding** gated by the approval workflow (§6.1),
- and the **defence-in-depth role split** that re-asserts the trust boundary in Postgres
  (`role-split.integration.test.ts`, §3) — a property you can't buy, only design in.

The integration *is* the product. Buying the parts doesn't remove the build; it relocates it
to glue code we'd own anyway, minus the coherent threat model.

---

## 5. The real fork: two platform visions

The static-only constraint isn't a minor feature choice — it's the load-bearing bet, and the
review should treat the alternative as a serious contender, not a footnote. There are two
coherent visions, and AZX's broader strategy — *build reusable functionality through consulting
engagements, then sell access to "the platform"* — is served by **both**, which is exactly why
the choice is hard.

**Vision A — thin apps, fat gateway (Helix today).** Apps are static frontends; all reusable
functionality lives in the platform and is reached only through a governed gateway (`/_api/*`).
Containment is by *surface reduction*: there's no untrusted server code to isolate, the gateway
is the single metered/audited choke point, and apps never hold secrets. Selling "access to
platform functionality" is clean here because the gateway **is** the product — metering, quotas,
and audit are intrinsic, not bolted on.

**Vision B — fat apps, strong isolation (Northflank-shaped).** Apps are full-stack; backends
run *inside* the platform, contained by microVM isolation (Firecracker/Kata/gVisor) rather than
by being absent. Reusable functionality is consumed as in-platform services, not only as
external gateway calls — backends *in* the platform instead of backends-as-sidecars we front
with APIs.

**Why the company strategy doesn't settle it.** The "sell platform functionality" motion is
**gateway-centric in both visions**: static or full-stack, the functionality you sell still
needs a governed, metered, audited API layer. Vision B doesn't remove that work — Northflank
gives you hosting + isolation + SSO + secrets, but **not** the LLM/data/third-party governed
gateway (§2.2); you build that on top either way. So adopting Northflank swaps "build the
hosting+isolation substrate" (done on ACA, M2–M4.5) for "buy the substrate, still build the
gateway." What actually differs is everything *around* the gateway:

| | Vision A — static + gateway | Vision B — full-stack + microVM |
|---|---|---|
| Rapid-prototyping / consulting fit | Constrained — frontend + gateway calls only; no arbitrary backend code | **Stronger** — real backend, any stack, fast; closest to how consultants already work |
| Attack surface | Minimal (static files only) | Larger (untrusted runtime), mitigated by hardware-level microVM isolation |
| Containment mechanism | Surface *reduction* | Surface *isolation* |
| Build cost | Build the platform on ACA (mostly done) | Largely buy the substrate (Northflank/BYOC), still build the gateway |
| Lock-in | Self-operated, portable | Substrate vendor (mitigated by BYOC) |

**The honest read.** Full-stack support is *not* a meaningful negative for app authoring — and
for a consulting-led "prototype fast on our platform" motion, Vision B's flexibility is a real
advantage. The price is a fundamentally larger trust boundary you contain with microVMs instead
of avoiding. Helix's static-only bet buys a dramatically smaller attack surface and a gateway
that is the *only* path to functionality (and therefore trivially meterable) — at the cost of
authoring flexibility. Neither is wrong; they optimize for different things. The decision the
review should actually make: **for our motion, is the value in the smallest-possible attack
surface with one governed choke point (A), or in maximum authoring flexibility with isolation
doing the containment (B)?**

**A hybrid is on the table** and worth naming: keep Vision A's gateway as the metered product,
but relax static-only toward a constrained backend tier (e.g. a thin per-app serverless/function
runtime) when prototyping demands it — buying authoring flexibility incrementally without
surrendering the choke point. That's a roadmap question, not a build-vs-buy one.

---

## 6. Honest tradeoffs — when "buy" would actually win

A design review should hear the strongest version of the other side:

- **Full-stack vs. static is the real fork** — covered in depth in §5. It's the most serious
  challenge to the build decision, and it turns on app-authoring flexibility vs. attack-surface
  size, *not* on the gateway (which both visions need to build).
- **If we only needed LLM governance** (no hosting, no third-party fetch) → buy **Portkey/Kong**
  and stop. The hosting + egress + isolation work only pays off because apps need *more* than
  model calls.
- **If this were a multi-tenant SaaS business**, not an internal platform for one org → the
  ops/SLA/billing surface would favor a managed PaaS; we explicitly scope to "tens of apps,
  one org" (§2, C8) and keep multi-org as a non-blocking future (§9).
- **Component-level buys we should keep open:** wrapping the `LlmProvider` seam around
  LiteLLM/Portkey, and the prod `SecretStore` around Key Vault (already the M5 plan). These
  are "buy a part behind a seam," which the architecture is explicitly built to allow — and
  they don't change the build-vs-buy verdict on the platform.

**Cost of building:** real, and concentrated in the auth handoff and the gateway/egress planes
(M3–M4.5, mostly done locally). **Cost of buying:** the integration glue above, *plus* accepting
someone else's trust boundary for our most sensitive asset (untrusted-app secrets), *plus*
vendor lock-in on the choke point that is our stated main value-add (§1).

---

## 7. Conclusion

The market validates every *piece* of the design — untrusted-code isolation, AI gateways,
secret-injecting egress, and enterprise governance are all real, funded product categories in
2026, which is reassuring evidence we're solving real problems the right way. But the pieces
are sold separately, each wired to a different threat model, and **the one thing none of them
sells is the integration**: a static, untrusted vibe-coded app, isolated per-origin behind
platform-terminated SSO, that holds no secret and reaches the outside world only through one
governed, audited, SSRF-hardened choke point we operate ourselves.

That integration, around that single stance, is Helix — and **if the static-only bet holds,
build is the right call**, with the door left open to buy *components* behind the seams we
already designed for them (§4, §6).

The one decision this doc can't make for the review is the fork in §5: thin apps + a fat
governed gateway (Vision A, what we've built) vs. full-stack apps + microVM isolation (Vision
B, Northflank-shaped). The company's "sell access to platform functionality" motion needs the
governed gateway in *either* vision, so it doesn't choose for us. The real question is whether
our consulting-led, prototype-fast motion is better served by the smallest-possible attack
surface or by maximum authoring flexibility. Settle that, and build-vs-buy falls out of it.

---

## Sources

Market research conducted June 2026 for this review:

- [Northflank — Enterprise vibe coding: deploy AI-generated apps safely](https://northflank.com/blog/enterprise-vibe-coding-how-to-deploy-ai-generated-apps-safely)
- [Northflank — Best enterprise-safe platforms for hosting AI apps (2026)](https://northflank.com/blog/best-enterprise-safe-platforms-for-running-and-hosting-ai-apps)
- [Superblocks — Low-code platforms for AI governance (2026)](https://www.superblocks.com/blog/ai-governance-features-low-code-app-platforms)
- [Cloudflare — Workers for Platforms: Worker isolation docs](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/worker-isolation/)
- [Cloudflare — Multi-tenant platform development](https://www.cloudflare.com/solutions/platforms/)
- [Zuplo — Best API gateways for AI/LLM workloads (2026)](https://zuplo.com/learning-center/best-api-gateways-ai-llm-workloads-2026)
- [slashllm — AI gateway comparison: LiteLLM vs Portkey vs Kong (2026)](https://slashllm.com/resources/ai-gateway-comparison)
- [ToolJet — Lovable vs Bolt vs v0 (2026)](https://blog.tooljet.com/lovable-vs-bolt-vs-v0/)
- [Replit — Replit vs v0](https://replit.com/discover/replit-vs-v0)
- [Blaxel — E2B alternatives: sandbox environments (2026)](https://blaxel.ai/blog/e2b-alternatives-sandbox-environments)
- [Vercel — Vercel Sandbox vs E2B](https://vercel.com/kb/guide/vercel-sandbox-vs-e2b)
- [E2B — The Enterprise AI Agent Cloud](https://e2b.dev/)
