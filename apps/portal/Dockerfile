# azx-portal production image.
#
# Build from the REPO ROOT (the build context is the whole pnpm workspace):
#   docker build -f apps/portal/Dockerfile -t <acr>/helix-portal:<tag> .
#
# The portal serves the React SPA from apps/portal-web/dist, so this image
# additionally installs + builds @azx-pbc/portal-web. `prisma generate` runs via
# the portal package's postinstall during install (Prisma 7, pg adapter). Runs
# via `tsx src/server.ts`; devDependencies stay in the image.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
# openssl: Prisma probes for libssl during install; ca-certificates: TLS to Postgres.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.5.3 --activate
WORKDIR /app

FROM base AS build
COPY . .
# Install the portal AND the SPA dependency closures. The portal postinstall runs
# `prisma generate` (offline codegen, no DB) — prisma.config.ts reads DATABASE_URL
# lazily via process.env, so no build-time database URL is needed.
RUN pnpm install --frozen-lockfile --filter @azx-pbc/portal... --filter @azx-pbc/portal-web...
# Build the SPA — the portal statically serves apps/portal-web/dist when present.
RUN pnpm --filter @azx-pbc/portal-web build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3001
CMD ["pnpm", "--filter", "@azx-pbc/portal", "start"]
