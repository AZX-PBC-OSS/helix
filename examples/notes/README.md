# notes

A small, fully self-contained AZX app: a notes/todo list that persists to
`localStorage`. No network calls, no external origins — the cleanest possible
CSP profile, so it deploys with zero warnings. It exercises a more realistic
bundle than `hello-world`: multiple TS modules, a stylesheet, an SVG favicon, a
PNG icon, and a web app manifest (`.svg .css .js .png .webmanifest`).

`dist/` is committed, so you can deploy it as-is. To rebuild after editing the
source, run a standalone install + build from this directory:

```bash
pnpm install --ignore-workspace
pnpm build
```

Then deploy with the `azx` CLI (`slug` and bundle dir come from `azx.json`). See
[`../README.md`](../README.md) for the deploy walkthrough.
