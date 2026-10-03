# azx-portal production image.
#
# Build from the REPO ROOT (the build context is the whole pnpm workspace):
#   docker build -f apps/portal/Dockerfile -t <acr>/helix-portal:<tag> .
#
# The portal serves the React SPA from apps/portal-web/dist, so this image
# additionally installs + builds @azx-pbc/portal-web. `prisma generate` runs via
# the portal package's postinstall during install (Prisma 7, pg adapter). Runs
# via `node --import tsx src/server.ts` — the `tsx` LOADER, not the CLI (the
# CLI installs a SIGTERM/SIGINT handler that exits 143 outright and would
# defeat graceful shutdown, see packages/shared/src/lifecycle.ts);
# devDependencies stay in the image.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
# openssl: Prisma probes for libssl during install; ca-certificates: TLS to Postgres.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.5.3 --activate
WORKDIR /app

# Offline IP geolocation for the Visitors view (ADR-0050): DB-IP City Lite,
# CC-BY 4.0. Its own stage, ahead of the workspace install, so the ~127 MB layer
# is cached independently of dependency changes. It needs only node: the
# downloader imports nothing outside node:* and Node 24 strips its types.
#
#   GEOIP_DB_MONTH   empty: this month, else last month; a failed download warns
#                    and the image ships without location.
#                    YYYY-MM: that release, and a failed download fails the build.
#                    skip: no download.
#   GEOIP_CACHE_KEY  changes the layer's cache key without pinning a release.
#                    CI passes the current month so a cached layer refreshes
#                    monthly. A failed unpinned download is cached under the same
#                    key, so rebuild with a new key to retry it.
FROM node:24-bookworm-slim AS geo
ARG GEOIP_DB_MONTH=""
ARG GEOIP_CACHE_KEY=""
COPY apps/portal/src/geo/fetchDb.ts /geo/fetchDb.ts
RUN mkdir -p /out && echo "geoip cache key: ${GEOIP_CACHE_KEY:-none}" && \
    if [ "$GEOIP_DB_MONTH" = "skip" ]; then \
      echo "geoip: skipped"; \
    elif [ -n "$GEOIP_DB_MONTH" ]; then \
      node /geo/fetchDb.ts --out /out/dbip-city-lite.mmdb "$GEOIP_DB_MONTH"; \
    else \
      node /geo/fetchDb.ts --out /out/dbip-city-lite.mmdb \
        || echo "warning: geoip download failed; building without visitor location"; \
    fi

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
# An absent file degrades to "location unavailable", not a boot failure.
ENV PORTAL_GEOIP_DB_PATH=/app/apps/portal/geo/dbip-city-lite.mmdb
COPY --from=build /app /app
# Empty when the geo stage skipped or failed; the portal then reports location
# as unavailable.
COPY --from=geo /out/ /app/apps/portal/geo/
USER node
EXPOSE 3001
CMD ["pnpm", "--filter", "@azx-pbc/portal", "start"]
