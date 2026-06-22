# azx-edge production image.
#
# Build from the REPO ROOT (the build context is the whole pnpm workspace):
#   docker build -f apps/edge/Dockerfile -t <acr>/helix-edge:<tag> .
#
# The app runs via `tsx src/server.ts` and consumes @helix/shared as raw TS
# (its `exports` point at ./src), so the image keeps devDependencies (tsx,
# typescript) — there is no compiled dist. @helix/dev-idp is a devDependency
# used only by tests and is never imported at runtime.
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
RUN pnpm install --frozen-lockfile --filter @helix/edge...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 8080
CMD ["pnpm", "--filter", "@helix/edge", "start"]
