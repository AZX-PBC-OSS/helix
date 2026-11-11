/** One budget for buffered dispatch and recovery. Each wait drops its timer when
 * complete, so response streams retain caller cancellation without a wall-clock cap. */
export class ResourceDeadline {
  readonly #expiresAt: number;
  constructor(
    readonly caller: AbortSignal,
    timeoutMs = 30_000,
  ) {
    this.#expiresAt = Date.now() + timeoutMs;
  }

  async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const remaining = this.#expiresAt - Date.now();
    this.caller.throwIfAborted();
    if (remaining <= 0) throw new DOMException("resource deadline exceeded", "TimeoutError");
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException("resource deadline exceeded", "TimeoutError")),
      remaining,
    );
    timer.unref();
    try {
      return await work(AbortSignal.any([this.caller, timeout.signal]));
    } finally {
      clearTimeout(timer);
    }
  }
}
