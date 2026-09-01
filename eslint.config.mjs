// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

// Flat config per the typescript-eslint quick-start.
// https://typescript-eslint.io/getting-started/

// `no-restricted-syntax` selectors, hoisted to consts because they are shared by
// two config blocks below. Flat config replaces a rule's options WHOLESALE for
// overlapping `files`, so a later block that re-declares this rule must re-state
// every selector that still applies — otherwise it silently deletes the others.
const RLS_MESSAGE =
  "Raw SQL against an RLS-partitioned table (app_data / gateway_calls / app_collection_items / sessions) must run inside a `withPartition` client (apps/edge/src/db/partition.ts), which sets the app.app_id GUC the RLS policy needs — otherwise it fails closed. Move the query into the store module for that table (ADR-0002).";
const RLS_TABLES = "(app_data|gateway_calls|app_collection_items|sessions)";
const RLS_LITERAL = {
  selector: `Literal[value=/\\b(from|into|update|join)\\s+"?${RLS_TABLES}\\b/i]`,
  message: RLS_MESSAGE,
};
const RLS_TEMPLATE = {
  selector: `TemplateElement[value.raw=/\\b(from|into|update|join)\\s+"?${RLS_TABLES}\\b/i]`,
  message: RLS_MESSAGE,
};

const POOL_CONNECT_MESSAGE =
  "Bare `pool.connect()`: pg-pool REMOVES the client's 'error' listener for the duration of a checkout (_acquireClient), and pg emits 'error' SYNCHRONOUSLY on a socket death while deferring the query rejection to nextTick — so a mid-transaction connection drop is an unhandled 'error' event that kills the edge before your `await client.query()` ever rejects. Use `withPooledClient` (or `withPartition`, which composes it) from apps/edge/src/db/pool.ts: it covers the window and destroys the dead client instead of returning it to the pool.";
// Two selectors for the two shapes a pool reference takes: a bare identifier
// (`pool.connect()`) and a member/private field (`this.#pool.connect()`).
// Deliberately matched on the NAME, not the type — same coarseness the RLS rule
// above documents, so a pool variable not named `*pool` slips through.
const POOL_CONNECT_IDENT = {
  selector: 'CallExpression[callee.property.name="connect"][callee.object.name=/[Pp]ool$/]',
  message: POOL_CONNECT_MESSAGE,
};
const POOL_CONNECT_FIELD = {
  selector:
    'CallExpression[callee.property.name="connect"][callee.object.property.name=/[Pp]ool$/]',
  message: POOL_CONNECT_MESSAGE,
};

const URL_ATTR_MESSAGE =
  "This is a span/metric attribute key that carries a WHOLE URL (ADR-0037 decision 6). Several platform URLs carry a live credential in the query string — the Appendix A handoff `token`, the OIDC `code`, and (uncoverable by any name list) the fetch-proxy target's own query, which may hold an app's API key or an Azure SAS `sig` — and a span attribute lands in the same 30-day-retained backend a log line does. Record `url.path` and `http.route` instead, and put anything URL-shaped through `redactUrl` (@azx-pbc/shared/logging) first. The list lives in FORBIDDEN_URL_ATTRS (@azx-pbc/shared/telemetry).";
const URL_ATTR_LITERAL = {
  selector: "Literal[value=/^(url\\.full|http\\.url|http\\.target|url\\.query)$/]",
  message: URL_ATTR_MESSAGE,
};

const PROPAGATION_EXTRACT_MESSAGE =
  "`propagation.extract` continues a trace from an inbound `traceparent`. The edge and the portal must never do that (ADR-0037 decision 7): every request into the edge originates from untrusted app code, so honouring it would let an app graft itself onto platform traces, forge parentage between unrelated requests, and mint unbounded trace ids at no cost. Propagation runs inward only, on the edge → egress hop — egress is the one service that extracts, and it is not covered by this rule. `injectOnly` (@azx-pbc/telemetry) already makes such a call inert; this is the half that says so at the call site.";
const PROPAGATION_EXTRACT = {
  selector: 'CallExpression[callee.property.name="extract"][callee.object.name="propagation"]',
  message: PROPAGATION_EXTRACT_MESSAGE,
};

const OTEL_SDK_MESSAGE =
  "The OpenTelemetry SDK is confined to @azx-pbc/telemetry and the three `server.ts` files (ADR-0037 decisions 3 and 4). From `buildApp()` inward, import `@opentelemetry/api` — the facade is dependency-free and no-ops when unregistered, which is what keeps `buildApp()` pure and lets tests inject requests without an exporter. An SDK import here also puts require-time monkey-patching machinery in the process that terminates untrusted traffic.";

const LOG_URL_MESSAGE =
  "A URL reaching a log call must be redacted. The `@azx-pbc/shared/logging` guarantee is scoped to the pino `req.url` FIELD (see that module's docblock), and several platform URLs carry a live credential in the query string — the Appendix A handoff `token`, the OIDC `code`, and the fetch-proxy target's own query, which may hold an app's API key or an Azure SAS `sig`. In Azure this stdout is retained for 30 days. Two ways out: log it under the top-level key `url`, which `loggerOption`'s serializer redacts automatically, or wrap it yourself — `redactUrl(req.url)`. (issue #20 residual b)";
// Two shapes, matched where the value reaches the log UNWRAPPED. Note what
// passes naturally and needs no escape hatch: `redactUrl(req.url)` puts the
// member expression under an intervening CallExpression, so it is neither a
// direct argument nor a Property whose value is the member expression.
// Deliberately coarse, matched on NAME — the same coarseness the RLS rule above
// documents. It cannot see a URL laundered through a variable, and says so.
const LOG_URL_DIRECT = {
  selector:
    'CallExpression[callee.property.name=/^(trace|debug|info|warn|error|fatal)$/][callee.object.property.name="log"] > MemberExpression[property.name=/^(url|href|originalUrl)$/]',
  message: LOG_URL_MESSAGE,
};
const LOG_URL_PROPERTY = {
  selector:
    'CallExpression[callee.property.name=/^(trace|debug|info|warn|error|fatal)$/][callee.object.property.name="log"] ObjectExpression > Property[key.name!="url"][value.type="MemberExpression"][value.property.name=/^(url|href|originalUrl)$/]',
  message: LOG_URL_MESSAGE,
};

export default defineConfig([
  globalIgnores([
    "**/dist/**",
    "**/node_modules/**",
    "**/coverage/**",
    "**/*.tsbuildinfo",
    "apps/portal/src/db/generated/**",
    // Example apps are standalone projects, not part of the platform source
    // tree — they have their own build and aren't subject to platform lint.
    "examples/**",
  ]),
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    // Plain JS/mjs (build + dev scripts) run on Node. typescript-eslint turns
    // off `no-undef` for .ts files, but .mjs needs the node globals declared.
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    // The SPA is browser code: hooks rules on, browser globals instead of node.
    files: ["apps/portal-web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"]],
    languageOptions: { globals: globals.browser },
  },
  {
    // ADR-0002 partition-RLS backstop (TODO.md). The RLS-guarded tables the edge
    // touches — app_data / gateway_calls / app_collection_items / sessions — are
    // partitioned by the `app.app_id` (+ `app.user_oid`) GUC, and the ONLY place
    // that GUC is set is `withPartition` (apps/edge/src/db/partition.ts). A query
    // against one of those tables outside a `withPartition` client runs with no
    // GUC and fails closed (zero rows / WITH CHECK fails) — a silent correctness
    // bug. This is the cheap, coarse enforcement (Option A): the SQL for these
    // tables is allowed ONLY in the store modules that wrap it in withPartition
    // (see `ignores`); anywhere else in the edge it fails the build. It trusts
    // those files internally rather than proving each query sits inside a
    // withPartition call — a stronger structural fix (encapsulate the pool) is
    // deferred until this area grows.
    //
    // The same block also bans bare `pool.connect()` (ADR-0025 review finding 1),
    // for a structurally identical reason: the checkout window is a hole the
    // pool-level `'error'` listener cannot cover, so `withPooledClient`
    // (apps/edge/src/db/pool.ts) is the only sanctioned way to check a client out.
    files: ["apps/edge/src/**/*.ts"],
    ignores: [
      "apps/edge/src/**/*.test.ts",
      "apps/edge/src/gateway/data.ts",
      "apps/edge/src/gateway/usage.ts",
      "apps/edge/src/auth/sessions.ts",
      "apps/edge/src/test/**",
      // The one sanctioned `pool.connect()` lives here, inside the helper that
      // makes it safe. (Tests are exempt too, as with the RLS rule: they check
      // out raw clients to `SET ROLE` and prove the RLS boundary, and a crash
      // there is a test failure, not an outage.)
      "apps/edge/src/db/pool.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        RLS_LITERAL,
        RLS_TEMPLATE,
        POOL_CONNECT_IDENT,
        POOL_CONNECT_FIELD,
        URL_ATTR_LITERAL,
        PROPAGATION_EXTRACT,
        LOG_URL_DIRECT,
        LOG_URL_PROPERTY,
      ],
    },
  },
  {
    // The three store modules are exempt from the RLS-SQL ban (they are the
    // files that wrap those queries in `withPartition`) but NOT from the
    // checkout ban — they are its primary audience. Flat config replaces a
    // rule's options wholesale for overlapping files, so re-state what applies.
    files: [
      "apps/edge/src/gateway/data.ts",
      "apps/edge/src/gateway/usage.ts",
      "apps/edge/src/auth/sessions.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        POOL_CONNECT_IDENT,
        POOL_CONNECT_FIELD,
        URL_ATTR_LITERAL,
        PROPAGATION_EXTRACT,
        LOG_URL_DIRECT,
        LOG_URL_PROPERTY,
      ],
    },
  },
  {
    // ADR-0037 decisions 6 and 7 on the other two planes. Separate blocks
    // because the selector sets differ: egress is the ONE service allowed to
    // extract trace context (its caller is the edge, over a hop whose authority
    // comes from the signed instruction), so PROPAGATION_EXTRACT does not apply
    // to it. Tests are exempt — the adversarial suites name these very keys in
    // order to assert they are absent.
    files: ["apps/portal/src/**/*.ts"],
    ignores: ["apps/portal/src/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        URL_ATTR_LITERAL,
        PROPAGATION_EXTRACT,
        LOG_URL_DIRECT,
        LOG_URL_PROPERTY,
      ],
    },
  },
  {
    files: ["apps/egress/src/**/*.ts"],
    ignores: ["apps/egress/src/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", URL_ATTR_LITERAL, LOG_URL_DIRECT, LOG_URL_PROPERTY],
    },
  },
  {
    // The SDK boundary (ADR-0037 decision 3), which the ADR's own Consequences
    // section admits has no automated gate and ADR-0003's challenge outcome
    // asks for. `server.ts` is where the impure boot work already lives, so it
    // is the file allowed to reach for the SDK; tests are exempt because the
    // in-memory recording provider is how decision 10's adversarial cases are
    // written at all, and a devDependency ships nowhere.
    //
    // Matched at ANY depth, not `apps/*/src/server.ts`: there are FOUR server
    // entrypoints, not three — `apps/edge/src/devGateway/server.ts` is the one
    // the ADR undercounts (Amendment 2), and it is instrumented too.
    //
    // Subpaths of @azx-pbc/telemetry are deliberately NOT banned: the pino
    // trace-correlation mixin is one, and its module graph is the API facade
    // only. The root specifier is what pulls the SDK.
    files: ["apps/*/src/**/*.ts"],
    ignores: ["apps/*/src/**/server.ts", "apps/*/src/**/*.test.ts", "apps/*/src/test/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // `paths`, not `patterns`, for the two @azx-pbc specifiers: a
          // `patterns.group` entry is gitignore-style and prefix-matches, so
          // "@azx-pbc/telemetry" there would also ban every subpath — including
          // the trace-correlation mixin, whose whole design is that it is
          // importable from `buildApp()` because its module graph is the API
          // facade only. `paths` matches the exact specifier and nothing else.
          paths: [
            { name: "@azx-pbc/telemetry", message: OTEL_SDK_MESSAGE },
            {
              name: "@azx-pbc/telemetry/testing",
              message:
                "The recording telemetry provider is test-only — it registers real in-memory SDK providers as the OTel globals. Importing it from shipped code would start recording spans into a buffer nothing drains.",
            },
          ],
          patterns: [
            {
              group: [
                "@opentelemetry/sdk-*",
                "@opentelemetry/exporter-*",
                "@opentelemetry/core",
                "@opentelemetry/resources",
              ],
              message: OTEL_SDK_MESSAGE,
            },
          ],
        },
      ],
    },
  },
]);
