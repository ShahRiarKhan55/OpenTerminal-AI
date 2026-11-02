# One image runs the API, the monitoring worker and the backup job (same code, different command).
# Build context: the repository root (docker compose does this).

FROM node:22-slim AS build
WORKDIR /app
# Install from the lockfile only: reproducible, and fails if the lockfile and manifests disagree.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# --ignore-scripts: no dependency needs a build step (better-sqlite3 ships prebuilt binaries), and it keeps
# a compromised package's install script from running during the build.
RUN npm ci -w server --include-workspace-root=false --ignore-scripts
COPY server/tsconfig.json server/
COPY server/src server/src
RUN npm run build -w server

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci -w server --include-workspace-root=false --omit=dev --ignore-scripts && npm cache clean --force
# npm may hoist everything to /app/node_modules or nest some packages under server/: support both layouts.
RUN mkdir -p server/node_modules
# Fail the BUILD (not the first start) if the native SQLite binding cannot load on this platform.
RUN node -e "const D=require('better-sqlite3');const d=new D(':memory:');d.exec('create table t(x)');console.log('better-sqlite3 ok, sqlite',d.prepare('select sqlite_version() v').get().v)"

FROM node:22-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    API_HOST=0.0.0.0
WORKDIR /app/server
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY server/package.json ./
# Run unprivileged; /data is the only writable location and is a volume.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
