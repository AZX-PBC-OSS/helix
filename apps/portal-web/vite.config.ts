import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The portal API this dev server proxies to, and the port to serve on. Both
// follow the stack (scripts/stack-env.mjs) so a second, isolated stack can run
// its SPA alongside the developer's without either one moving.
const portalOrigin = process.env.PORTAL_ORIGIN ?? "http://localhost:3001";
const port = Number(process.env.PORTAL_WEB_PORT ?? 5173);

// Portal SPA (project plan §1): Vite + React, served by the Vite dev server in
// dev and statically by the portal container in prod. The proxy keeps the SPA
// same-origin with the portal API in dev — no CORS anywhere.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // devcontainer port-forwarding
    port,
    // Rolling to the next free port would silently break login: the origin is
    // the SPA's redirect_uri (src/auth/oidc.ts) and must match what the IdP
    // registered. Fail loudly instead.
    strictPort: true,
    proxy: {
      "/api": portalOrigin,
      "/health": portalOrigin,
    },
  },
  // Picked up as a project by the root vitest config.
  test: {
    name: "portal-web",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
