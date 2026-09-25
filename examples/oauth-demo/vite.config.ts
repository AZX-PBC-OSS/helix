import { defineConfig } from "vite";

// `base: "./"` makes built asset URLs relative, so the bundle works no matter
// what path the edge serves it from. Output goes to dist/ (committed to git).
export default defineConfig({
  base: "./",
});
