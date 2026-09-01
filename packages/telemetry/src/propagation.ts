import type { Context, TextMapPropagator, TextMapSetter } from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";

/**
 * Trace-context propagation, and the one direction it is allowed to run in
 * (ADR-0037 decision 7).
 *
 * **The edge never continues a trace from an app-user request.** Every request
 * into the edge originates from untrusted app code (ADR-0019, and the
 * platform's founding stance). Honouring an inbound `traceparent` would let an
 * app graft itself onto platform traces, forge parentage between unrelated
 * requests, and mint unbounded distinct trace ids at no cost. Trace context is
 * unauthenticated metadata by construction and can never carry authority.
 *
 * Propagation runs **inward only**, on the edge → egress hop, where the
 * request's authority already comes from the signed attested instruction
 * (ADR-0013). The `traceparent` rides alongside it as correlation, never read
 * for policy.
 */

/**
 * Wrap a propagator so `extract` is the identity: it can inject a trace context
 * outward, and can never continue one inward.
 *
 * **Why a wrapper and not just "don't call extract".** Today the edge ignores
 * an inbound `traceparent` only because nobody wrote a `propagation.extract()`
 * call — decision 4 rules out the auto-instrumentation that would write one
 * implicitly. That is correct and completely invisible, which makes it a
 * property that survives exactly as long as nobody adds a plausible-looking
 * line. This turns the absence into a mechanism: with it installed, an extract
 * call added later is inert rather than a silent trust boundary crossing. An
 * ESLint rule bans the call as well; this is the half that holds if the rule is
 * ever relaxed.
 */
export function injectOnly(inner: TextMapPropagator): TextMapPropagator {
  return {
    inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
      inner.inject(context, carrier, setter);
    },
    /**
     * Returns the context **unchanged** — not a context with a stripped span,
     * the same object. A caller cannot tell an ignored `traceparent` from an
     * absent one, which is the point.
     *
     * The carrier and getter parameters are omitted rather than named and
     * ignored: TypeScript accepts a narrower implementation of the interface,
     * and a signature that cannot see the carrier is a stronger statement than
     * one that can and chooses not to look.
     */
    extract(context: Context): Context {
      return context;
    },
    fields(): string[] {
      return inner.fields();
    },
  };
}

/**
 * The propagator `NodeTracerProvider.register()` installs when passed nothing:
 * W3C trace-context plus W3C baggage. Reconstructed here rather than inherited
 * so the inject-only variant wraps exactly the same thing the default would
 * have been — otherwise "inject-only" would also silently mean "and baggage
 * stopped propagating."
 */
export function defaultPropagator(): TextMapPropagator {
  return new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  });
}

/**
 * Which direction a service is allowed to propagate in.
 *
 * - `inject-only` — edge and portal. Both terminate untrusted traffic (the edge
 *   directly; the portal is not app-routable but is internet-facing), and
 *   neither has anything upstream of it whose trace it should join. Defaulting
 *   the control plane closed is the cheaper mistake: turning it on later is a
 *   decision, turning it off after something started depending on it is a
 *   regression.
 * - `full` — egress. It is the one service that *must* extract, because the
 *   edge → egress hop is the seam the whole exercise exists to make visible,
 *   and its caller is the trusted plane rather than an app.
 */
export type PropagationMode = "inject-only" | "full";

/** Resolve a {@link PropagationMode} to the propagator `register()` takes. */
export function propagatorFor(mode: PropagationMode): TextMapPropagator {
  const base = defaultPropagator();
  return mode === "inject-only" ? injectOnly(base) : base;
}
