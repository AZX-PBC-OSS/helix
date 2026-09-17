import { defineConfig } from "vitepress";

// The public docs site, published to GitHub Pages as a project page:
// https://azx-pbc-oss.github.io/helix/ — hence the base. Content lives in
// src/; apps/src/apps/quickstart.md is generated at build time from
// packages/deploy-skill/SKILL.md (scripts/render-skill.ts), per ADR-0036.
export default defineConfig({
  lang: "en-US",
  title: "Helix",
  description:
    "Secure hosting for AI-coded apps: static frontends, a same-origin gateway, and per-app capability grants.",
  base: "/helix/",
  srcDir: "src",
  cleanUrls: true,
  head: [
    // Head links don't get the base prefix automatically, so spell it out.
    ["link", { rel: "icon", type: "image/svg+xml", href: "/helix/favicon.svg" }],
    ["link", { rel: "alternate icon", type: "image/png", href: "/helix/favicon-256.png" }],
    ["link", { rel: "apple-touch-icon", sizes: "256x256", href: "/helix/favicon-256.png" }],
  ],
  themeConfig: {
    siteTitle: "Helix",
    nav: [
      { text: "Deploy", link: "/deploy/getting-started", activeMatch: "/deploy/" },
      { text: "Build an app", link: "/apps/quickstart", activeMatch: "/apps/" },
      { text: "Contributing", link: "/contributing" },
    ],
    sidebar: {
      "/deploy/": [
        {
          text: "Deploying Helix",
          items: [
            { text: "Getting started", link: "/deploy/getting-started" },
            { text: "Entra ID setup", link: "/deploy/entra-setup" },
            { text: "Access control", link: "/deploy/access-control" },
            { text: "Azure AI Foundry", link: "/deploy/foundry" },
            { text: "Deploying updates", link: "/deploy/updates" },
            { text: "Configuration reference", link: "/deploy/configuration" },
            { text: "Local development", link: "/deploy/local-dev" },
          ],
        },
      ],
      "/apps/": [
        {
          text: "Building apps",
          items: [
            { text: "Quickstart", link: "/apps/quickstart" },
            { text: "App manifest", link: "/apps/manifest" },
            { text: "The /_api gateway", link: "/apps/gateway" },
            { text: "The helix CLI", link: "/apps/cli" },
          ],
        },
      ],
      "/": [],
    },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/AZX-PBC-OSS/helix" }],
    outline: { level: [2, 3] },
    footer: {
      message: "Published from the open-source repo.",
      copyright: "AZX PBC",
    },
  },
});
