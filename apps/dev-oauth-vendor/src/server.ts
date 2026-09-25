import { startDevOAuthVendor } from "./start.js";

// Env-driven boot for `pnpm dev:vendor`. The fixture is a stand-in vendor for
// driving the connections flows by hand; test suites normally boot it
// in-process on an ephemeral port instead (startDevOAuthVendor / README).
const port = Number(process.env.OAUTH_VENDOR_PORT ?? 3003);

const { issuer } = await startDevOAuthVendor({ port });

console.log(`[dev-oauth-vendor] serving ${issuer} (never deploy this)`);
