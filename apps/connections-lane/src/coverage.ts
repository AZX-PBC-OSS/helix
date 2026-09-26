import type { Journey } from "@azx-pbc/dev-oauth-vendor";

/**
 * The fixture's journey vocabulary ↔ the lane's coverage (ADR-0010 §Shared
 * ground): the fixture exports the journey list so "a journey added to the
 * fixture's contract is visibly missing from any lane that has not covered it
 * yet". This record is compile-checked exhaustive — a new Journey id breaks
 * the lane's typecheck until a spec claims it.
 */
export const JOURNEY_COVERAGE: Record<Journey, string> = {
  "popup-consent-success": "journeys.spec.ts › explicit successful consent (both placements)",
  "popup-blocked": "journeys.spec.ts › blocked opening (the real popup blocker)",
  "consent-denied": "journeys.spec.ts › denial (keyboard-completable popup)",
  "consent-cancelled": "journeys.spec.ts › cancellation (popup closed mid-journey)",
  "consent-timeout": "failures.spec.ts › timeout on an already-expired attempt",
  "lost-completion-signaling": "failures.spec.ts › lost completion signaling",
  "safe-completion-notification":
    "failures.spec.ts › forged success rejected (app window + vendor page)",
};
