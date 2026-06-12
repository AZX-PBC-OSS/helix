# hello-world

The smallest possible AZX app: static HTML/CSS plus a line of JavaScript that
runs in the browser. Use it to smoke-test the deploy path end to end.

`dist/` is committed, so you can deploy it as-is. To rebuild after editing the
source, run a standalone install + build from this directory:

```bash
pnpm install --ignore-workspace
pnpm build
```

Then deploy with the `azx` CLI (`slug` and bundle dir come from `azx.json`). See
[`../README.md`](../README.md) for the deploy walkthrough.
