import { Readable } from "node:stream";
import type { EgressProvider, EgressRequest, EgressResponse } from "./egressProvider.js";
import type { JobsCallbackBurnStore, JobsCallbackBurnOutcome } from "../jobs/burns.js";

/**
 * The receiver suites' shared fakes — the callback burn store and the egress
 * provider, with the contracts their production classes state (`jobs/burns.ts`,
 * `egressProvider.ts`). The burn store is stateful the way the pg store is
 * (one use per `jti`, then replay); the egress fake observes its abort signal
 * the way the fetch suite's fake established — a fake that ignored the signal
 * would answer 200 while the edge was aborting it, and the bug would pass.
 */

export class FakeBurnStore implements JobsCallbackBurnStore {
  readonly burned: string[] = [];
  /** Force the next burn to answer as if the store could not answer. */
  unavailable: Error | null = null;

  async burn(jti: string): Promise<JobsCallbackBurnOutcome> {
    if (this.unavailable) return { verdict: "store-unavailable", error: this.unavailable };
    if (this.burned.includes(jti)) return { verdict: "replay" };
    this.burned.push(jti);
    return { verdict: "first-use" };
  }
}

export class FakeEgress implements EgressProvider {
  calls: EgressRequest[] = [];
  status = 200;
  outcome = "ok";
  responseBody: Readable | null = null;
  delayMs = 0;
  abortedDuringCall = false;
  failure: Error | null = null;

  async proxy(req: EgressRequest): Promise<EgressResponse> {
    this.calls.push(req);
    let settled = false;
    if (req.signal.aborted) this.abortedDuringCall = true;
    else {
      req.signal.addEventListener(
        "abort",
        () => {
          if (!settled) this.abortedDuringCall = true;
        },
        { once: true },
      );
    }
    if (this.delayMs > 0) await this.#holdOpen(req.signal);
    settled = true;
    if (this.failure) throw this.failure;
    return {
      status: this.status,
      headers: { "content-type": "application/json" },
      body: this.responseBody ?? Readable.from([Buffer.from(JSON.stringify({ ok: true }))]),
      outcome: this.outcome,
    };
  }

  #holdOpen(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, this.delayMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async close(): Promise<void> {}
}
