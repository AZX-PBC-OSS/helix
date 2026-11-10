---
title: Ejecting an app
description: "Take your app beyond Helix: keep the static frontend, identify the APIs it uses, and implement them on a backend of your choice using the OpenAPI reference."
---

# Ejecting an app

You can start on Helix and move your app elsewhere as its needs grow. Your
frontend is ordinary HTML, CSS, and JavaScript; its dynamic features call HTTP
APIs. The exit path is to host that frontend yourself and replace the Helix
APIs it uses with a backend of your choice.

## What to replace

1. **Inventory the app's dependencies.** Find its `/_api/*` calls, including
   SDK base URLs, and check its [manifest](./manifest). Include identity, model
   calls, stored data, external API connections, and background jobs where used.
   Also check for platform-provided behavior such as the fetch shim or offline
   service worker described in the [gateway guide](./gateway).
2. **Implement the APIs the app uses.** The generated
   [app API reference](./api-reference) and
   [OpenAPI document](/helix/openapi/app-api.json){target="_self"} give humans
   and coding agents the request and response contracts. Use the gateway guide
   for behavior such as streaming and data access rules. Keeping the same paths
   and contracts on the new origin lets existing frontend calls keep working;
   you can also change the frontend to suit your new backend. Only the subset
   your app uses needs replacing.
3. **Move state and configure services.** Migrate stored data, preserving or
   mapping user IDs so each person's data remains theirs. Coordinate with your
   Helix operator for data the app cannot read; collections have owner-facing
   export routes in the [portal API](../deploy/portal-api-reference). Configure
   credentials on the new backend and reconnect user accounts where needed.
4. **Deploy and verify.** Host the frontend with your backend and test the user
   flows, including sign-in, access restrictions, errors, and any streaming or
   background work.

Your new host also takes over what Helix handles around those APIs: TLS,
sign-in and access control, secret storage, and any budgets or limits you need.
Keep credentials on the backend. An app that only serves static content needs
only static hosting plus whatever access control you want to retain.
