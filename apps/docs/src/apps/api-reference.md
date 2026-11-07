---
title: App API reference
description: "Generated reference for every /_api/* endpoint a hosted app can call: request and response schemas, status codes, and error envelopes."
aside: false
outline: false
---

<script setup>
import spec from "@azx-pbc/openapi/app-api.json";
</script>

# App API reference

This page lists every endpoint of the [`/_api` gateway](./gateway), generated
from the same schemas the platform validates with. Read the gateway guide first:
it explains the capabilities, the manifest grants they need, and the limits.
This page is the field-level detail.

The machine-readable document is at
[`/helix/openapi/app-api.json`](/openapi/app-api.json){target="_self"}. It is
OpenAPI 3.1, so client generators and agents can read it directly.

The reference describes the latest release. A deployment running an older
release may not have every endpoint yet.

<OASpec :spec="spec" />
