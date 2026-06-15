import { startDevIdp } from "./start.js";

// Env-driven boot for `pnpm dev:idp`. The issuer must read identically from
// the host browser and from in-container back-channel calls, which is why the
// IdP runs in the workspace container on a forwarded port (plan: M3 §B) —
// `http://localhost:3002` is then literally true on both sides.
const port = Number(process.env.IDP_PORT ?? 3002);

const { issuer } = await startDevIdp({
  port,
  edgeClientSecret: process.env.IDP_EDGE_CLIENT_SECRET,
  edgeRedirectUris: process.env.IDP_EDGE_REDIRECT_URIS?.split(",").map((u) => u.trim()),
  webRedirectUris: process.env.IDP_WEB_REDIRECT_URIS?.split(",").map((u) => u.trim()),
});

console.log(`[dev-idp] issuing as ${issuer} (never deploy this)`);
