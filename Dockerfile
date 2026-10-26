# Node 24 runs the TypeScript directly (native type stripping) and ships
# node:sqlite, so there is no build step and nothing to compile. Major version
# is pinned; 24.x security updates come in on a rebuild.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
# scripts/backup.ts runs inside this container from a cron on the host.
COPY scripts ./scripts

# The database lives on a volume, owned by the unprivileged user the app runs
# as. Doing this in the image means the volume inherits the ownership.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV AWM_DB=/data/awm.db \
    AWM_HOST=0.0.0.0 \
    AWM_PORT=8787

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "--no-warnings=ExperimentalWarning", "src/index.ts"]
