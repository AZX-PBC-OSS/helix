/**
 * The platform-served `window.helix` global — injected at serve time when the
 * app's manifest grants `capabilities.shim.connect` (the connect-helper
 * contract, docs/features/fetch-proxy.md §Entry path 1).
 */
export {};

declare global {
  interface HelixConnectResult {
    /**
     * `connected` — consent granted and saved; `already_connected` — a working
     * connection existed (nothing was sent to the vendor); `denied` — declined
     * at the vendor; `cancelled` — popup closed without completing;
     * `timeout` — five minutes elapsed; `blocked` — the browser refused the
     * popup (no user gesture, or a blocker); `signin_required` — no usable app
     * session; `error` — platform-side failure, `reason` names it.
     */
    outcome:
      | "connected"
      | "already_connected"
      | "denied"
      | "cancelled"
      | "timeout"
      | "blocked"
      | "signin_required"
      | "error";
    provider: string;
    /** Correlation tag — absent on `blocked`, where nothing was started. */
    attempt?: string;
    /** Present only with the `error` outcome: `conflict`, `provider_unavailable`,
     * `provider_misconfigured`, `provider_incompatible`, `service_unavailable`. */
    reason?: string;
  }

  interface Window {
    helix: {
      connect: (providerRef: string) => Promise<HelixConnectResult>;
    };
  }
}
