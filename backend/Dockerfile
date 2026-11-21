# One image, three roles: api, worker, mock-whatsapp (chosen by the command).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
RUN npm run build

# Used by `docker compose --profile test run --rm tests`
FROM deps AS test
COPY . .
CMD ["npx", "vitest", "run"]

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
# Certificate files volume must be writable by the non-root user.
RUN mkdir -p /data/certs && chown -R node:node /data
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
