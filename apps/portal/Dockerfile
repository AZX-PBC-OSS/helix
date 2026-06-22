# azx-portal production image.
#
# Build from the REPO ROOT (the build context is the whole pnpm workspace):
#   docker build -f apps/portal/Dockerfile -t <acr>/helix-portal:<tag> .
#
# The portal serves the React SPA from apps/portal-web/dist, so this image
# additionally installs + builds @helix/portal-web. `prisma generate` runs via
# the portal package's postinstall during install (Prisma 7, pg adapter). Runs
# via `tsx src/server.ts`; devDependencies stay in the image.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.5.3 --activate
WORKDIR /app

FROM base AS build
COPY . .
# Install the portal AND the SPA dependency closures (postinstall runs prisma generate).
RUN pnpm install --frozen-lockfile --filter @helix/portal... --filter @helix/portal-web...
# Build the SPA — the portal statically serves apps/portal-web/dist when present.
RUN pnpm --filter @helix/portal-web build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3001
CMD ["pnpm", "--filter", "@helix/portal", "start"]
