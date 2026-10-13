# One long-lived container serves the API and the UI (the Qloo harness needs a long-lived process too).
FROM node:22.19.0-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.19.0-slim
WORKDIR /app
# Qloo answers are cached on disk so restarts don't spend the monthly quota; mount a volume at /data to
# keep them across deploys too.
ENV NODE_ENV=production PORT=8080 TRUST_PROXY=1 QLOO_CACHE_FILE=/data/qloo-cache.json
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
USER node
EXPOSE 8080
CMD ["node", "dist/server/main.js"]
