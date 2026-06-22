# azx-egress production image.
#
# Build from the REPO ROOT (the build context is the whole pnpm workspace):
#   docker build -f apps/egress/Dockerfile -t <acr>/helix-egress:<tag> .
#
# Runs via `tsx src/server.ts` and consumes @helix/shared and
# @helix/secret-store as raw TS, so devDependencies stay in the image.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.5.3 --activate
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter @helix/egress...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 8081
CMD ["pnpm", "--filter", "@helix/egress", "start"]
