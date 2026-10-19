# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Multi-stage build for the single Riffle image. The same image runs the API
# (and web UI) or the background worker, selected with MODE=api|worker.
# Build from the repository root:  docker build -f docker/Dockerfile .

ARG NODE_VERSION=22

# ---- base: Node + pnpm via corepack (version pinned by package.json) --------
FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- manifests: only files that affect dependency resolution ----------------
# Copying these alone keeps the install layer cached until dependencies change.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/simplefin/package.json packages/simplefin/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/

# ---- build: full install (incl. dev deps) and compile everything ------------
FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm -r build

# ---- prod-deps: production dependencies only --------------------------------
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ---- runtime: small, non-root image -----------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime

# The Node base image can lag behind Debian security fixes. perl-base ships in
# every Debian slim image and is the package the CI vulnerability scan flags
# (CVE-2026-8376), so pull the patched version. Upgrade only this package to
# keep the layer small and the build reproducible; drop this step once the
# upstream base image includes the fix.
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade perl-base \
    && rm -rf /var/lib/apt/lists/*

ARG APP_VERSION=dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Riffle" \
      org.opencontainers.image.description="Free and open source small business bookkeeping software" \
      org.opencontainers.image.source="https://github.com/fubarpie/riffle-accounting" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

ENV NODE_ENV=production \
    MODE=api \
    PORT=3000 \
    WEB_DIST=/app/web \
    RIFFLE_MIGRATIONS_DIR=/app/migrations \
    DATA_DIR=/data \
    APP_VERSION=${APP_VERSION}

WORKDIR /app

# Production node_modules keep their relative pnpm symlinks because the
# directory layout matches the prod-deps stage.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/web/dist ./web
COPY --from=build /app/packages/db/migrations ./migrations
COPY LICENSE NOTICE ./
COPY docker/entrypoint.sh /usr/local/bin/riffle-entrypoint

RUN chmod 0755 /usr/local/bin/riffle-entrypoint \
    && mkdir -p /data/statements \
    && chown -R node:node /data

USER node
VOLUME ["/data"]
EXPOSE 3000

# Both modes expose /healthz on $PORT.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["riffle-entrypoint"]
