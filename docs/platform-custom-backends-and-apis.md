# AZX App Platform — Custom Backends & the API/Capability Fleet (research memo)

**Status:** Research draft v1 · June 2026
**Companion to:** `platform-architecture.md` (the _what & why_) and `platform-project-plan.md` (the _with what & in what order_)
**Why this exists:** There are no concrete custom-backend requirements yet. This memo exists so that when they arrive we are not flying blind or implementing into a corner — it fleshes out a _potential_ plan, names the load-bearing decisions, and marks which of today's choices keep that future open versus foreclose it. It is deliberately ahead of demand; nothing here is committed.

External claims are cited inline to the primary sources the research pass verified (vendor docs, protocol specs). Where this memo reasons from our own architecture rather than a cited source — most of the service-discovery section — it says so.

---

## 1. The one thing that must survive

Today's containment model rests on a single move (architecture decision 1): **untrusted code only ever runs in the browser**, sandboxed by origin + CSP, and the gateway is the one dynamic surface. Custom backends break that invariant — they reintroduce *server-side* untrusted code, the exact thing v1 cut to shrink isolation work "by an order of magnitude."

So the orchestrator question (k8s? ACA? Firecracker?) is **downstream**. The load-bearing decision is the trust posture, and the invariant that must survive every option below is:

> **A custom backend is just another untrusted tenant. It gets its capabilities *through* the gateway, holds no ambient cloud credentials, and the gateway stays the single choke point for identity, authz, quota, and audit.**

If a backend can hold secrets and hit cloud APIs directly, we have lost the single-choke-point value proposition (architecture §6) and traded it for a generic container host. Everything that follows is in service of keeping that invariant true while letting code run server-side.

**Strong external corroboration that this shape is right:** Cloudflare's Workers for Platforms is near-identical prior art. A single *dynamic dispatch Worker* is the entry point for every request and runs platform logic — authentication, rate limiting, request validation — **before any untrusted customer code executes**; tenant code is **untrusted by default** and isolated per tenant; and optional **Outbound Workers** intercept all `fetch()` egress for logging, allow/block lists, and server-side credential injection so tenants never hold secrets.[^wfp][^wfp-iso][^wfp-out] That maps almost one-to-one onto our edge gateway, our "every app is untrusted" stance, and our fetch-proxy (§6.1). We arrived at the same architecture independently — which is the best evidence the seams are in the right places.

---

## 2. The isolation landscape (what a real boundary costs)

The research is unambiguous on one point: **the right isolation technology depends entirely on whether we run a *constrained runtime* or *arbitrary container images*.** These are two different products with two different cost curves.

### Tier 1 — Constrained runtimes (functions): dense, but not a standalone boundary
V8 isolates are the production standard for running many untrusted JS/Wasm tenants per host, because process-per-tenant is ~10× the CPU cost at density (Cloudflare's own number, independently corroborated at ~8× in academic measurement).[^cf-spectre][^deno] Deno Subhosting uses the same isolate model.[^deno]

The catch, stated plainly by both operators: **isolates are not a hard side-channel boundary.** Cloudflare runs them only behind layered compensating controls — timing freezes (`Date.now()` is locked to request-receipt time), dynamically rescheduling suspicious workers into their own process, and daily memory-shuffling restarts; Deno layers OS-level namespaces, seccomp, and cgroups underneath.[^cf-spectre][^deno] Isolates buy density and *require* defense-in-depth; they never stand alone.

### Tier 2 — Arbitrary container images: needs a real kernel boundary
For arbitrary images you need a genuine kernel boundary, and there are two production-proven options:

- **User-space kernel (gVisor).** The Sentry re-implements the syscall surface in user space — *no guest syscall passes through to the host kernel*; the Sentry itself makes only ~50–70 audited host calls under seccomp.[^gvisor] Categorically stronger than namespaces, at some syscall-compatibility and I/O cost.
- **microVMs (Firecracker).** The dominant choice: Fly.io runs customer Docker images in Firecracker, the same engine behind AWS Lambda and Fargate.[^fly] It shrinks the trusted surface toward the KVM subsystem (Firecracker is ~50–80k LOC Rust with ~5 virtio devices vs QEMU's ~2M LOC).[^fly] Honest caveat from the one split vote in the research: the true trusted surface is KVM *plus* the userspace VMM device code, and guests can still reach some host-kernel paths via operation forwarding (USENIX Security 2023) — "only KVM" is a useful simplification, not a guarantee.

### Kubernetes: namespaces are not a security boundary
This is the most important correction to the "multi-cloud → k8s" reflex. Per AWS's own EKS guidance, **a host compromise exposes all Secrets, ConfigMaps, and Volumes mounted on that node** — namespaces and RBAC are soft multi-tenancy, not a boundary against hostile code.[^eks] Running untrusted tenants on k8s requires *adding* pod sandboxing (Firecracker/gVisor via a `runtimeClass`, or Fargate) plus default-deny network policy on top.[^eks] In other words: **k8s is an orchestrator, not an isolation mechanism.** Whatever isolation tier we pick from Tier 2, we'd still be bringing it ourselves.

But do **not** over-rotate the other way: the research explicitly *refuted* (1–2) the claim that separate clusters per tenant are required — sandboxing + network policy is an accepted hard-multi-tenancy substitute.[^eks] So cluster-per-app is not the price of admission.

---

## 3. The rung ladder (the build plan)

The plan is a ladder, not a leap. Each rung is independently shippable, and each one's "do we need the next rung yet?" gate is the §11 criterion: *the third real app that can't ship on the rung below.*

| Rung | What it is | Trust posture | Isolation needed | When |
|------|------------|---------------|------------------|------|
| **0** | Extend gateway primitives — cron/scheduled triggers, **inbound** webhook receivers routed through the gateway, richer app/user data queries | No new untrusted runtime; same as today | None new (runs in our trusted plane) | First, and may absorb most "I need a backend" asks |
| **1** | **Constrained serverless functions** — our runtime, one or two languages (JS/Wasm), no arbitrary base image, no ambient network. The architecture's named "phase 2: serverless functions" (§12) | Untrusted tenant code, but on a substrate *we* control | V8 isolates / Wasm + compensating controls (Tier 1) | When apps need real custom logic but not arbitrary images |
| **2** | **Arbitrary container images** — the author's image and dependencies | Fully untrusted server-side code | Real kernel boundary: Firecracker or gVisor (Tier 2) | Last, and only if rung 1 genuinely can't serve a class of apps |

The crucial reframes this ladder forces:

1. **Most "I need a backend" is rung 0.** "Save my stuff," "call an API with a secret," "call a third-party API," "talk to an internal tool" are already §6 capabilities (app/user data KV, secret-backed connections, fetch-proxy, MCP-as-REST). The genuinely uncovered shapes are narrower: scheduled work, inbound webhooks, long-lived connections, and real custom logic. Sorting incoming asks into this taxonomy is the cheapest thing we can do, and it's what tells us whether we're building two primitives or a container platform.
2. **Rung 1 is the high-leverage middle.** A constrained function runtime delivers the bulk of "custom backend" value at a fraction of Tier 2's isolation surface, because we own the execution substrate. This is where the Workers-for-Platforms model lives, and it's where I'd expect to spend the most design time.
3. **Only rung 2 needs the heavy isolation + (plausibly) k8s.** Defer it hard. It's the rung that turns us into a container host, and the §11 "resist until the third app" discipline matters most here.

---

## 4. The API/capability fleet: split policy from mechanism

This is the second question — "it doesn't make sense to run all the APIs inside our app containers" — and it's correct. As §6.1's catalog grows (LLM proxy, app data, file storage, fetch-proxy, MCP passthrough, secret-backed connections), cramming every capability *implementation* into the edge collides head-on with two hard rules we've written down: the edge is **dependency-minimal** (every package is trusted-path code) and **boring, rarely redeployed**. MCP SaaS-connector SDKs inside the trusted edge is a non-starter on its face. We already took the first step — §3 makes the fetch-proxy egress its own container (`azx-egress`) for SSRF isolation and secret custody (`docs/design/{fetch-proxy,secrets-and-connections}.md`). Generalize that into a principle:

### Policy plane vs mechanism plane
- **Edge gateway = policy plane.** Terminates the session, resolves the `(app, user)` dual identity (§6.2), evaluates the grant ("app X, on behalf of user Y, wants capability Z" — §6.3), enforces quota, writes the audit record. Thin, trusted, dependency-minimal. **Stays in the edge** — it is the value-add and must remain one choke point.
- **Capability services = mechanism plane.** Actually perform the LLM call, the outbound fetch, the MCP translation. They carry the fat dependencies, scale independently, and sit in their own network zones (the fetch-proxy in an SSRF-isolated egress zone). They **trust the edge's attested identity and never re-authenticate the end user**, so a compromised connector service can't read sessions or mint identity — it only sees what the edge attested. Blast radius contained, exactly like apps.

This is the canonical **Envoy `ext_authz` policy-enforcement-point** pattern: a thin enforcement layer in front, capability backends behind.[^spiffe-jwt-opa] And it composes cleanly with rung 1/2 above — **a custom backend is just another capability service that registers with the gateway**, under the same admission, identity, and audit model.

### Gateway → backend identity attestation
How does a less-trusted backend trust "the gateway already authenticated this caller" without re-auth? The proven answer is **SPIFFE/SPIRE workload identity**: workloads bootstrap identity via out-of-band attestation (kernel/orchestrator introspection — *no credential-zero problem*, the workload never presents a pre-shared secret to get its identity),[^spiffe-ep] and a SPIRE-issued **JWT-SVID carried over mTLS** lets a backend trust an Envoy-fronted caller, with issuance/validation delegated to the SPIRE agent rather than app code.[^spiffe-jwt-opa] For our scale we can start simpler — a **signed internal identity header** minted by the edge (same `jose` primitives the handoff token already uses), carrying `(app, user, capability, request-id)` — and graduate to SPIFFE/mTLS if/when the fleet and threat model warrant it. The header shape is forward-compatible with the SVID shape, so starting simple doesn't foreclose the mesh.

### Service discovery: push, because we already do
> **Note:** the research pass did *not* surface citable primary sources comparing push (xDS) vs pull (Consul/etcd/k8s DNS) discovery — this section is reasoning from our own architecture, flagged as such. Treat it as a proposal to validate, not a sourced finding.

We already run a push model: the edge reads a cached registry projection refreshed sub-second via Postgres `LISTEN/NOTIFY` (§7). The consistent move is to **do the same thing for capability services**: the control plane owns a *capability/service registry*, services authenticate (workload identity) and *advertise* what they serve, the control plane **admits** them (an approval step — you don't want any pod that boots to claim it serves `llm`), and projects the resulting endpoint map to the edge.

Why push fits our grain specifically:
- **Zero new trusted-path dependencies.** Pull-based discovery (Consul/etcd/k8s DNS) means a new runtime dependency *inside the dependency-minimal edge*, and worse, couples the gateway to specific infra (k8s-native DNS would tie the edge to k8s — see §5).
- **Admission is a control-plane decision**, exactly like capability grants — privileged, approved, audited. It belongs in the portal, projected to the edge, same as the app registry.
- **It's the same code pattern we've already validated**, so it's the lowest-novelty option.

The named industry pattern for "control plane streams endpoints/routes to data-plane proxies" is **xDS** (Envoy's model), which §4.2 already floated. The real fork to evaluate later: *build the projection ourselves* (consistent with our app-registry approach, no new trusted-path deps) **vs** *adopt an xDS control plane* (more power, more dependency). My lean is build-our-own at tens-of-apps scale; revisit if the fleet grows.

### The egress capability's load-bearing lesson
Whatever runs untrusted code, the governed-fetch / egress story must **block ambient cloud-metadata access** (`169.254.169.254`) — the Capital One SSRF vector that extracts IAM credentials.[^imds-aws][^imds-dd] IMDSv2's defenses (require a PUT-initiated session token via a custom header that SSRF primitives usually can't set; refuse tokens to any request carrying `X-Forwarded-For`) are the model for what our egress proxy must enforce — belt-and-suspenders: disable IMDSv1 *and* block the metadata IP outright for code that doesn't need it.[^imds-aws][^imds-dd] And note the honest limit of the Workers-for-Platforms analogy: Outbound Workers govern *runtime `fetch()` subrequests at the application layer*, not a network firewall — a determined escape from the runtime bypasses it.[^wfp-out] For Tier 2 (arbitrary containers) we need network-level egress policy underneath, not just application-layer interception.

---

## 5. Where k8s actually fits (and where it must not)

The multi-cloud instinct toward k8s is reasonable, with two hard guardrails from the research:

1. **k8s is an orchestrator, not isolation.** Namespaces don't contain hostile code (§2).[^eks] Adopting k8s for rung 2 means *also* adopting Firecracker/gVisor + default-deny network policy on top — that's the actual security work, and it's the same work on ACA-with-microVMs or bare Firecracker. So k8s doesn't *solve* untrusted-backend isolation; it organizes it.
2. **Adopt it for the untrusted-backend tier only — never the trusted plane.** The edge and portal are two boring containers whose virtue is low ops and a tiny trusted surface. Moving them onto a complex orchestrator because *app backends* need one would couple our boring trusted path to k8s's operational complexity and blast radius — a real regression. The portability rule (§8: Azure only behind internal interfaces; data path is "plain containers + Postgres + S3-able storage") is satisfied by k8s-as-backend-substrate without dragging the control/data plane along.

And the decoupling that keeps options open: **the capability-fleet story (§4) is orchestrator-agnostic** — push-projection discovery works on ACA, k8s, or Nomad. So we can ship the policy/mechanism split *now*, on ACA, with no k8s, and it stays useful even if rung 2 never arrives. The trap to avoid is letting "we might use k8s for backends someday" pull k8s-native discovery into the trusted edge today.

---

## 6. The seams to protect now (cheap insurance against a corner)

None of this is build-now. But a few invariants are nearly free to honor today and expensive to retrofit — these are the "don't implement into a corner" list:

1. **Keep identity, authz, quota, and audit strictly in the edge policy plane.** Never let a capability implementation (even today's in-process ones) own those decisions. The day we extract a capability into its own service, the choke point must already live above it. *Status: holds today; the risk is a future capability quietly embedding its own authz.*
2. **Mint capability calls with an explicit `(app, user, capability, request-id)` identity, even in-process.** If today's internal capability calls already pass a structured identity object rather than reaching into session state ad hoc, extracting a service later is a transport swap, not a re-architecture. The signed-header form (§4) is the same `jose` we already run for handoff tokens.
3. **Model the registry projection as "things the edge consumes," not "apps."** If the LISTEN/NOTIFY projection is generic enough to carry a second kind of record (services, not just apps) later, the capability-fleet discovery is additive — same as the §8 decision to key everything by app-id so an org-id is additive.
4. **Treat any future backend as a tenant in the data model from day one.** A backend's grants, quotas, and audit records key off the same `(app)` partition apps already use. Don't invent a parallel "service" identity space that bypasses the capability model.
5. **Hold the §11 line.** Resist rungs 1 and 2 until the third real app forces them. The cheapest custom-backend is the one a gateway primitive (rung 0) made unnecessary.

---

## 7. Decisions & trade-offs (provisional — for debate, not committed)

| # | Leaning | Alternative | Why |
|---|---------|-------------|-----|
| B1 | Custom backends inherit the per-app untrusted-tenant model; capabilities still flow through the gateway | Backends get direct cloud/secret access | Preserves the single-choke-point value prop (§6); a backend with ambient creds is just a container host |
| B2 | Rung ladder: gateway primitives → constrained functions → arbitrary containers | Jump straight to arbitrary containers | Most asks are rung 0–1; only rung 2 needs heavy isolation. Defer the expensive rung |
| B3 | Rung 1 on constrained runtime (isolates/Wasm) + compensating controls | Containers for everything | Density and a substrate we control; isolates are cheap but need defense-in-depth[^cf-spectre][^deno] |
| B4 | Rung 2 on Firecracker/gVisor, k8s for the backend tier *only* | k8s for the whole platform; or namespaces as the boundary | Namespaces aren't a boundary;[^eks] don't couple the boring trusted plane to k8s (§5) |
| B5 | Split policy plane (edge) from mechanism plane (capability services) | Keep growing the in-edge gateway | Protects the dependency-minimal trusted path; lets the catalog grow without bloating the edge |
| B6 | Push-projection discovery from a control-plane service registry | Pull-based (Consul/etcd/k8s DNS) | Reuses our LISTEN/NOTIFY pattern; no new trusted-path deps; orchestrator-agnostic *(reasoning, not sourced — validate)* |
| B7 | Gateway→backend identity: signed internal header now, SPIFFE/mTLS later | SPIFFE/SPIRE from day one | Header shape is forward-compatible with JWT-SVID;[^spiffe-jwt-opa] start at our scale, graduate when warranted |

---

## 8. Open questions (including honest research gaps)

1. **gVisor vs Firecracker at our density** — the research found no head-to-head ops/cost comparison. gVisor (syscall-compat + I/O cost) vs Firecracker (per-instance memory/boot overhead); which keeps EKS/AKS/GKE portability most open? Needs a hands-on spike before rung 2.
2. **Wasm runtimes (Wasmtime/Spin) and Kata as rung-1/2 substrates** — named in scope but produced no verified claims. Are Wasm runtimes a real boundary for the rung-1 function tier, and what's their multi-cloud maturity? This directly affects the rung-1 substrate choice.
3. **Push vs pull discovery, validated** — the core Cluster B question yielded no citable sources. The §4 recommendation is reasoning from our own LISTEN/NOTIFY precedent; it deserves a proper xDS-vs-build-our-own evaluation before we commit.
4. **The §11 trigger, sharpened** — what concrete app shapes actually can't ship on rung 0 + today's gateway? We can't answer this without the taxonomy of real asks, which is the cheapest next step regardless of when we build.

---

## Sources

Verified primary sources from the June 2026 research pass. All claims rest predominantly on vendor/spec primary sources (authoritative for design intent, self-reported on security efficacy); the two most quantitative claims have independent academic corroboration. The space moves quarterly — re-check before committing.

[^cf-spectre]: Cloudflare — Workers security model / Spectre mitigations. https://blog.cloudflare.com/mitigating-spectre-and-other-security-threats-the-cloudflare-workers-security-model/
[^deno]: Deno — Subhosting: running untrusted code. https://deno.com/blog/subhosting-security-run-untrusted-code
[^gvisor]: gVisor — Security architecture. https://gvisor.dev/docs/architecture_guide/security/
[^fly]: Fly.io — Sandboxing and workload isolation. https://fly.io/blog/sandboxing-and-workload-isolation/
[^eks]: AWS — EKS Best Practices: multi-tenancy. https://aws.github.io/aws-eks-best-practices/security/docs/multitenancy/
[^wfp]: Cloudflare — How Workers for Platforms works. https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/
[^wfp-iso]: Cloudflare — Worker isolation in dispatch namespaces. https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/
[^wfp-out]: Cloudflare — Outbound Workers. https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/
[^spiffe-ep]: SPIFFE — Workload Endpoint spec. https://github.com/spiffe/spiffe/blob/main/standards/SPIFFE_Workload_Endpoint.md
[^spiffe-jwt-opa]: SPIFFE — Envoy + JWT-SVID + OPA (ext_authz). https://spiffe.io/docs/latest/microservices/envoy-jwt-opa/readme/
[^imds-aws]: AWS — Defense in depth: SSRF and the EC2 instance metadata service. https://aws.amazon.com/blogs/security/defense-in-depth-open-firewalls-reverse-proxies-ssrf-vulnerabilities-ec2-instance-metadata-service/
[^imds-dd]: Datadog Security Labs — IMDS misconfiguration spotlight. https://securitylabs.datadoghq.com/articles/misconfiguration-spotlight-imds/
