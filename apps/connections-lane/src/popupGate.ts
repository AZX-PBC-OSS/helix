import type { CDPSession, Page } from "@playwright/test";

/**
 * The popup boundary's request gate — CDP `Fetch` domain, because Playwright's
 * own route layer does not intercept requests that arrive as REDIRECT
 * continuations (measured: the consent popup's authorize request and the
 * vendor's callback redirect both bypass `page.route`), and the consent
 * journey is a chain of redirects. CDP Fetch pauses every matching request —
 * redirect or not — which gives the lane its deterministic hold points:
 *
 * - hold at the vendor's authorize request (the consult has committed; the
 *   vendor has not been asked) — the timeout and forged-message journeys;
 * - hold at the callback (the vendor has answered) — the cancellation journey;
 * - hold the callback's RESPONSE (the save has committed; the completion page
 *   is in flight) — the lost-completion-signaling journey.
 *
 * Attach BEFORE the popup travels: `over(context, pattern)` installs on every
 * page the context opens (the popup included) the moment it exists, so the
 * gate is armed long before the popup's second hop.
 */

export interface HeldRequest {
  url: string;
  method: string;
  /** Resume a Request-stage hold. */
  continueRequest(): Promise<void>;
  /** Answer a Request-stage hold with a synthetic response. */
  respond(status: number, contentType: string, body: string): Promise<void>;
  /** Kill a Request-stage hold (the network failure a closed popup causes). */
  failRequest(): Promise<void>;
  /** The real response body at a Response-stage hold. */
  responseBody(): Promise<string>;
  /** Answer a Response-stage hold with a (possibly modified) body. */
  respondModified(status: number, contentType: string, body: string): Promise<void>;
  /** Let a Response-stage hold through unmodified. */
  continueResponse(): Promise<void>;
}

export class PopupGate {
  readonly #sessions: CDPSession[] = [];
  readonly #pending: HeldRequest[] = [];
  readonly #waiters: Array<(held: HeldRequest) => void> = [];
  readonly #attaches: Promise<void>[] = [];

  /**
   * Resolves when the first `count` attaches (the opener, then the popup, in
   * creation order) have Fetch enabled — the deterministic arming signal: a
   * journey holds the popup's FIRST navigation (which Playwright's own route
   * layer does intercept) until this resolves, so the gate cannot lose the
   * race against the popup's redirect chain. Waits for the attach promises to
   * EXIST, not just for the first ones: the popup's attach is registered when
   * its page event dispatches, which can be after this call starts.
   */
  async attached(count: number): Promise<void> {
    while (this.#attaches.length < count) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(this.#attaches.slice(0, count));
  }

  static async over(
    context: import("@playwright/test").BrowserContext,
    urlPattern: string,
    stage: "Request" | "Response" = "Request",
  ): Promise<PopupGate> {
    const gate = new PopupGate();
    // Attach to pages that already exist AND to every future one (the popup).
    const attach = (page: Page): Promise<void> => {
      const attachPromise = (async () => {
        const session = await context.newCDPSession(page);
        gate.#sessions.push(session);
        await session.send("Fetch.enable", {
          patterns: [{ urlPattern, requestStage: stage }],
        });
        session.on(
          "Fetch.requestPaused",
          (evt: { requestId: string; request?: { url: string; method: string } }) => {
            const requestId = evt.requestId;
            const sessionRef = session;
            const held: HeldRequest = {
              url: evt.request?.url ?? "",
              method: evt.request?.method ?? "GET",
              continueRequest: async () => {
                await sessionRef.send("Fetch.continueRequest", { requestId });
              },
              respond: async (status, contentType, body) => {
                await sessionRef.send("Fetch.fulfillRequest", {
                  requestId,
                  responseCode: status,
                  responseHeaders: [
                    { name: "content-type", value: contentType },
                    { name: "cache-control", value: "no-store" },
                  ],
                  body: Buffer.from(body, "utf8").toString("base64"),
                });
              },
              failRequest: async () => {
                await sessionRef.send("Fetch.failRequest", {
                  requestId,
                  errorReason: "Failed",
                });
              },
              responseBody: async () => {
                const res = await sessionRef.send("Fetch.getResponseBody", { requestId });
                const raw = res.base64Encoded
                  ? Buffer.from(res.body, "base64")
                  : Buffer.from(res.body, "utf8");
                return raw.toString("utf8");
              },
              respondModified: async (status, contentType, body) => {
                await sessionRef.send("Fetch.fulfillRequest", {
                  requestId,
                  responseCode: status,
                  responseHeaders: [
                    { name: "content-type", value: contentType },
                    { name: "cache-control", value: "no-store" },
                  ],
                  body: Buffer.from(body, "utf8").toString("base64"),
                });
              },
              continueResponse: async () => {
                await sessionRef.send("Fetch.continueResponse", { requestId });
              },
            };
            gate.#offer(held);
          },
        );
      })();
      gate.#attaches.push(attachPromise);
      return attachPromise;
    };
    for (const page of context.pages()) await attach(page);
    context.on("page", (page) => {
      void attach(page);
    });
    return gate;
  }

  #offer(held: HeldRequest): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(held);
    else this.#pending.push(held);
  }

  /** The next paused request (resolves immediately when one is held). */
  next(): Promise<HeldRequest> {
    const held = this.#pending.shift();
    if (held) return Promise.resolve(held);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async close(): Promise<void> {
    for (const session of this.#sessions) {
      await session.send("Fetch.disable").catch(() => {});
      await session.detach().catch(() => {});
    }
    this.#sessions.length = 0;
  }
}
