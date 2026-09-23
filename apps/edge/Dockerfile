# azx-edge production image.
#
# Build from the REPO ROOT (the build context is the whole pnpm workspace):
#   docker build -f apps/edge/Dockerfile -t <acr>/helix-edge:<tag> .
#
# The app runs via `node --import tsx src/server.ts` — the `tsx` LOADER, not the
# tsx CLI — and consumes @azx-pbc/shared as raw TS (its `exports` point at
# ./src), so the image keeps devDependencies (tsx, typescript) — there is no
# compiled dist. The loader-vs-CLI distinction is load-bearing, not style: the
# tsx CLI installs its own SIGTERM/SIGINT handler that exits 143 outright,
# which would defeat the services' graceful-shutdown drain before it starts
# (packages/shared/src/lifecycle.ts). `node --import tsx` loads TS with no
# handler of its own, so the process's own signal handling is the only one.
# @azx-pbc/dev-idp is a devDependency used only by tests and is never imported
# at runtime.
#
# Follow-up (not blocking the pilot): precompile to dist + prune devDeps to
# shrink the image.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.5.3 --activate
WORKDIR /app

FROM base AS build
COPY . .
# Install only the edge package's dependency closure (...= include workspace deps).
RUN pnpm install --frozen-lockfile --filter @azx-pbc/edge...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 8080
CMD ["pnpm", "--filter", "@azx-pbc/edge", "start"]
