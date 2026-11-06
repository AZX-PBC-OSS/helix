/**
 * Route contracts for the published APIs (ADR-0054). Import from
 * `@azx-pbc/shared/contracts`; the package barrel does not re-export these.
 */
import type { RouteContract } from "./define.js";
import { platformSettingsContracts } from "./portal/platformSettings.js";

export * from "./define.js";
export * from "./conformance.js";
export { apiError, portalRoute } from "./portal/common.js";
export * as portal from "./portal/index.js";
export * as app from "./app/index.js";

/** Every route in the portal API (`/api/v1/*`). */
export const portalContracts: readonly RouteContract[] = [...platformSettingsContracts];

/** Every route in the app API (`/_api/*`). */
export const appContracts: readonly RouteContract[] = [];
