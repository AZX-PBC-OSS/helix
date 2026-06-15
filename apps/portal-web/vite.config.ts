import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Portal SPA (project plan §1): Vite + React, served by the Vite dev server in
// dev and statically by the portal container in prod. The proxy keeps the SPA
// same-origin with the portal API in dev — no CORS anywhere.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // devcontainer port-forwarding
    proxy: {
      "/api": "http://localhost:3001",
      "/health": "http://localhost:3001",
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
