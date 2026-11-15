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
    AICHAT_DB=/app/data/aichat.db
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/config /app/data && chown -R node:node /app/config /app/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "dist/broker/main.js"]
