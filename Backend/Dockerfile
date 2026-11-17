# syntax=docker/dockerfile:1

# ---- build: compile TypeScript and keep only production dependencies ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
# Toolchain only in this stage, in case better-sqlite3 has no prebuilt binary for the target platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    TZ=Europe/Rome
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY certs ./certs
COPY docs ./docs
COPY scripts/docker-entrypoint.sh /usr/local/bin/madovai-entrypoint
RUN mkdir -p /data && chown node:node /data && chmod +x /usr/local/bin/madovai-entrypoint
# No `USER node` here on purpose: the entrypoint fixes /data ownership as root, then drops to "node" (see the script).
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/madovai-entrypoint"]
