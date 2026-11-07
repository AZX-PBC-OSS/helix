import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import type { RouteContract } from "@azx-pbc/shared/contracts";
import { authenticate, ownsApp } from "./auth.js";

export interface ContractRouteOptions {
  /** Run before authentication, e.g. a feature gate that answers 404 when off. */
  before?: preHandlerAsyncHookHandler[];
  /** Run after authentication and the ownership check. */
  after?: preHandlerAsyncHookHandler[];
  /**
   * Replace the ownership check the contract implies, for a route whose
   * ownership rule is conditional.
   */
  ownership?: preHandlerAsyncHookHandler;
}

/**
 * Register a portal route from its contract (ADR-0054). The method and path
 * come from the contract, and so does authentication: `bearer` adds
 * `authenticate`, and `owner` adds `ownsApp`. The published spec and the
 * enforced checks therefore read the same declaration.
 */
export function contractRoute(
  app: FastifyInstance,
  contract: RouteContract & { owner?: boolean },
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  opts: ContractRouteOptions = {},
): void {
  const preHandler: preHandlerAsyncHookHandler[] = [...(opts.before ?? [])];
  if (contract.auth === "bearer") preHandler.push(authenticate);
  if (opts.ownership) preHandler.push(opts.ownership);
  else if (contract.owner) preHandler.push(ownsApp);
  preHandler.push(...(opts.after ?? []));
  app.route({
    method: contract.method,
    url: contract.path,
    ...(preHandler.length > 0 ? { preHandler } : {}),
    handler,
  });
}
