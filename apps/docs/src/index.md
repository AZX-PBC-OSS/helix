---
title: Helix
---

# Helix

Helix is secure hosting for apps written by AI coding agents. It runs your app as
a static frontend, and gives it a same-origin API gateway for everything else:
language models, app data, and outbound HTTP. Apps can't hold secrets, and
everything an app may do is declared in a manifest that the platform enforces.

The security model is simple to state: **every hosted app is untrusted code.**
Helix doesn't try to verify what an app does. It contains what an app can do.
The platform is split into three services along that boundary — a public edge
that serves apps and terminates traffic, a control plane that owns deployments
and approvals, and an egress service that is the only thing with a route to the
internet.

## What do you want to do?

**[Deploy Helix](/deploy/getting-started)** — run your own instance on Azure.
The whole platform deploys from one Bicep template: Container Apps, private
Postgres and Blob storage, Key Vault, wildcard TLS, and telemetry. Your users
sign in through your own Microsoft Entra tenant.

**[Build an app](/apps/quickstart)** — write an app and put it on an existing
Helix instance. An app is HTML, CSS, and JavaScript. There is no server code.
You deploy with the `helix` CLI, and the platform handles TLS, SSO, the gateway,
and per-app budgets.

## Where the code is

Helix is open source: [github.com/AZX-PBC-OSS/helix](https://github.com/AZX-PBC-OSS/helix).
The repo also carries the contributor documentation — architecture records,
design docs, and the decision log (ADRs) — which lives in [`docs/`](https://github.com/AZX-PBC-OSS/helix/tree/main/docs)
on GitHub rather than on this site.
