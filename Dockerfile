# MFP self-host: the server and the built editor in one image (docs/self-host.md).
# Build: docker build -t mfp .   Run everything together: docker compose up -d
#
# The image gets only build output: the editor (apps/editor/dist) and the server as one minified module
# per entry point (scripts/build-server.ts) — no sources, tests or comments; from node_modules —
# only runtime dependencies (wasm, native modules).

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Manifests first (the dependency layer stays cached while they don't change).
COPY package.json package-lock.json ./
COPY apps/cli/package.json apps/cli/
COPY apps/desktop/package.json apps/desktop/
COPY apps/editor/package.json apps/editor/
COPY apps/server/package.json apps/server/
COPY apps/viewer/package.json apps/viewer/
COPY packages/core/package.json packages/core/
COPY packages/editing/package.json packages/editing/
COPY packages/io-figma/package.json packages/io-figma/
COPY packages/layout/package.json packages/layout/
COPY packages/plugin-host/package.json packages/plugin-host/
COPY packages/renderer/package.json packages/renderer/
COPY packages/sync/package.json packages/sync/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build -w @mfp/editor && node scripts/build-server.ts
# Runtime: no dev dependencies and no links to our packages (they are already inside the build).
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund && rm -rf node_modules/@mfp

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8080 MFP_DATA=/data MFP_STATIC=/app/editor
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./server
COPY --from=build /app/apps/editor/dist ./editor
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://localhost:8080/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/main.mjs"]
