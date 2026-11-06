---
title: Portal API reference
description: "Generated reference for the portal's /api/v1 control-plane API used by the helix CLI, the portal UI, and operator automation."
aside: false
outline: false
---

<script setup>
import spec from "@azx-pbc/openapi/portal-api.json";
</script>

# Portal API reference

The portal API is what the `helix` CLI and the portal UI call. Operators can
call it too, for automation. Every route except the configuration bootstrap
needs a bearer token: run `helix login`, or use a portal dev token.

This page is generated from the same schemas the portal validates with. The
machine-readable document is at
[`/helix/openapi/portal-api.json`](/openapi/portal-api.json){target="_self"},
and a running portal serves the document for its own release at
`GET /api/v1/openapi.json`.

<OASpec :spec="spec" />
