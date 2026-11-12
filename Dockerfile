# syntax=docker/dockerfile:1
# Node 22 is the version this project was built and tested on.
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Bundled read-only data: geodata.json.gz (country/territorial-water polygons), aircraft-types.json, ao-boxes.json
COPY data ./data
# Persistent state (state.json). Mount a volume here; the node user must be able to write to it.
ENV STATE_DIR=/app/state
RUN mkdir -p /app/state && chown node:node /app/state
VOLUME /app/state
USER node
EXPOSE 8080
# /healthz returns 503 only when the state directory is not writable or the Discord gateway is down (GeoFS outages are reported as "degraded", HTTP 200).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8080)+'/healthz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
