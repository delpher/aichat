# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    AICHAT_HOST=0.0.0.0 \
    AICHAT_PORT=8787 \
    AICHAT_CONFIG=/app/config/agents.json \
    AICHAT_DB=/app/data/aichat.db \
    AICHAT_HOME=/app/versions
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# /app is the built-in version; updates installed from the web UI go to the /app/versions volume.
RUN mkdir -p /app/config /app/data /app/versions && chown -R node:node /app/config /app/data /app/versions
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1
# The launcher starts the newest installed version and restarts it after a self-update (see src/launcher.ts).
CMD ["node", "dist/launcher.js"]
