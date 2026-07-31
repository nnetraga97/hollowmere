# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY engine/package.json engine/package.json
COPY scheduler/package.json scheduler/package.json
COPY harness/package.json harness/package.json
COPY web/package.json web/package.json
RUN npm ci

FROM dependencies AS source
COPY tsconfig.json ./
COPY engine ./engine
COPY scenario ./scenario
COPY scheduler ./scheduler
COPY web ./web

FROM dependencies AS migration
WORKDIR /app
ENV NODE_ENV=production

COPY --chown=node:node db ./db
COPY --chown=node:node engine ./engine
COPY --chown=node:node scenario ./scenario
COPY --chown=node:node scripts/migrate.ts scripts/publish-scenario.ts ./scripts/

USER node
CMD ["npm", "run", "deploy:migrate"]

FROM source AS web-build
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run web:build

FROM node:24-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    SERVICE_NAME=hollowmere-web

COPY --from=web-build --chown=node:node /app/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/web/.next/static ./web/.next/static
COPY --from=web-build --chown=node:node /app/web/public ./web/public

USER node
EXPOSE 3000
CMD ["node", "web/server.js"]

FROM node:24-bookworm-slim AS scheduler
WORKDIR /app
ENV NODE_ENV=production \
    SERVICE_NAME=hollowmere-scheduler

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node engine ./engine
COPY --chown=node:node scenario ./scenario
COPY --chown=node:node scheduler ./scheduler

USER node
CMD ["node", "scheduler/worker.ts"]
