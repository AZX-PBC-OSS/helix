/**
 * Route contracts for the published APIs (ADR-0054). Import from
 * `@azx-pbc/shared/contracts`; the package barrel does not re-export these.
 */
import type { RouteContract } from "./define.js";
import { platformSettingsContracts } from "./portal/platformSettings.js";
import { appsContracts } from "./portal/apps.js";
import { approvalsContracts } from "./portal/approvals.js";
import { secretsContracts } from "./portal/secrets.js";
import { devTokensContracts } from "./portal/devTokens.js";
import { repoBindingContracts } from "./portal/repoBinding.js";
import { providersContracts } from "./portal/providers.js";
import { catalogueContracts } from "./portal/catalogue.js";
import { configContracts } from "./portal/config.js";
import { authContracts } from "./portal/auth.js";
import { cspContracts } from "./portal/csp.js";
import { versionsContracts } from "./portal/versions.js";
import { ciVersionsContracts } from "./portal/ciVersions.js";
import { usageContracts } from "./portal/usage.js";
import { visitorsContracts } from "./portal/visitors.js";
import { sessionsContracts } from "./portal/sessions.js";
import { dataContracts } from "./portal/data.js";
import { directoryContracts } from "./portal/directory.js";
import { connectionsMineContracts } from "./portal/connectionsMine.js";
import { meContracts as appMeContracts } from "./app/me.js";
import { llmContracts as appLlmContracts } from "./app/llm.js";
import { openaiContracts as appOpenaiContracts } from "./app/openai.js";
import { dataContracts as appDataContracts } from "./app/data.js";
import { connectionsContracts as appConnectionsContracts } from "./app/connections.js";
import { fetchContracts as appFetchContracts } from "./app/fetch.js";
import { jobsContracts as appJobsContracts } from "./app/jobs.js";

export * from "./define.js";
export * from "./conformance.js";
export { apiError, portalRoute } from "./portal/common.js";
export * as portal from "./portal/index.js";
export * as app from "./app/index.js";

/** Every route in the portal API (`/api/v1/*`). */
export const portalContracts: readonly RouteContract[] = [
  ...platformSettingsContracts,
  ...appsContracts,
  ...approvalsContracts,
  ...secretsContracts,
  ...devTokensContracts,
  ...repoBindingContracts,
  ...providersContracts,
  ...catalogueContracts,
  ...configContracts,
  ...authContracts,
  ...cspContracts,
  ...versionsContracts,
  ...ciVersionsContracts,
  ...usageContracts,
  ...visitorsContracts,
  ...sessionsContracts,
  ...dataContracts,
  ...directoryContracts,
  ...connectionsMineContracts,
];

/** Every route in the app API (`/_api/*`). */
export const appContracts: readonly RouteContract[] = [
  ...appMeContracts,
  ...appLlmContracts,
  ...appOpenaiContracts,
  ...appDataContracts,
  ...appConnectionsContracts,
  ...appFetchContracts,
  ...appJobsContracts,
];
