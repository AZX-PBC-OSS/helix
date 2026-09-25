/**
 * The lane/support composition surface for @azx-pbc/edge (I-02 T-0031,
 * ADR-0010 part 2): the seam set an out-of-package real-browser lane needs to
 * compose the REAL edge the way the in-package integration suites do —
 * registry projection, session store, usage ledger, and the two inter-service
 * HTTP clients. Re-exports only; no behavior lives here.
 *
 * Every export is production code the edge's own suites already construct;
 * nothing here reaches into private internals, and nothing here is on any
 * runtime import path — the lane is a devDependency consumer, never a runtime
 * one (ADR-0010: Playwright never joins a runtime package).
 */
export { LiveRegistry } from "../registry/listener.js";
export { PgSessionStore, hashSessionToken, newSessionId } from "../auth/sessions.js";
export { PgUsageStore } from "../gateway/usage.js";
export { HttpEgressProvider } from "../gateway/egressProvider.js";
export { HttpPortalProvider } from "../routing/portalProvider.js";
export { deriveInstructionKey } from "../gateway/instruction.js";
