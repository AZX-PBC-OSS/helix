import type { FastifyReply } from "fastify";
import {
  AUTH_PAGE_CSP,
  operatorFooter,
  renderAuthPage,
  renderSiteAbout,
  type SiteOperator,
} from "./authChrome.js";

/**
 * `GET /` on the bare apps domain and the auth host: what this site is and who
 * runs it. `no-cache`, so an operator edit shows on the next visit and a replica
 * that has not loaded the settings yet never seeds a shared cache.
 */
export function sendAboutPage(reply: FastifyReply, operator: SiteOperator | null): void {
  reply
    .status(200)
    .header("cache-control", "no-cache")
    .header("content-security-policy", AUTH_PAGE_CSP)
    .header("x-frame-options", "DENY")
    .type("text/html; charset=utf-8")
    .send(
      renderAuthPage({
        title: operator?.name ? `Private app hosting · ${operator.name}` : "Private app hosting",
        heading: "Private app hosting",
        sub: "Apps on this site are shared directly by their owners. Use the link you were sent.",
        bodyHtml: renderSiteAbout(operator),
        footHtml: operatorFooter(operator),
      }),
    );
}
