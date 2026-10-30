# azx-jobs production image.
#
# Build from the REPO ROOT (the build context is the whole pnpm workspace):
#   docker build -f apps/jobs/Dockerfile -t <acr>/helix-jobs:<tag> .
#
# Runs via `node --import tsx src/server.ts` — the `tsx` LOADER, not the CLI
# (the CLI installs a SIGTERM/SIGINT handler that exits 143 outright and would
# defeat graceful shutdown, see packages/shared/src/lifecycle.ts) — and
# consumes @azx-pbc/shared and @azx-pbc/telemetry as raw TS, so
# devDependencies stay in the image.
#
# The service process IS the container's init process: node runs directly,
# WORKDIR at the package, not through `pnpm --filter … start`. pnpm 11 does
# not forward SIGTERM to its script (observed: the grandchild keeps serving
# after the signal), so a pnpm CMD would defeat the graceful-shutdown drain —
# the runtime would SIGKILL a service that never drained.
#
# The service is the jobs runner (ADR-0008): it holds only its own three
# signing roots and its own database DSN, supplied at run time — the image
# bakes in no credentials, and the migration identity
# (`helix_jobs_migrate`) is never installed in a runtime image; migrations
# run through the separately executed `db:migrate` command under that
# identity (background-jobs-plane design §8).

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.5.3 --activate
WORKDIR /app

FROM base AS build
COPY . .
# Install only the jobs package's dependency closure (...= include workspace deps).
RUN pnpm install --frozen-lockfile --filter @azx-pbc/jobs...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
# tsx resolves from the package's own node_modules, hence the WORKDIR.
WORKDIR /app/apps/jobs
USER node
EXPOSE 3003
CMD ["node", "--import", "tsx", "src/server.ts"]
