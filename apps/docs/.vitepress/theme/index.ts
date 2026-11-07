import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import { theme as openapiTheme } from "vitepress-openapi/client";
import "vitepress-openapi/dist/style.css";

// The default theme plus vitepress-openapi's components, which render the API
// reference pages from the generated specs (ADR-0054). Each reference page
// passes its own spec to <OASpec>, so nothing is configured globally here.
export default {
  extends: DefaultTheme,
  async enhanceApp(ctx) {
    await openapiTheme.enhanceApp(ctx);
  },
} satisfies Theme;
