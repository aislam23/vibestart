FROM oven/bun:1.3.14 AS build

WORKDIR /app

# Copy the repository instead of enumerating workspace manifests, so this build stays valid as
# other workspaces (webapp, website) are added.
COPY . .

RUN bun install --frozen-lockfile --filter @vibestart/backend

WORKDIR /app/backend

RUN DATABASE_URL="postgresql://postgres:postgres@localhost:54322/postgres" bun run prisma:generate

FROM oven/bun:1.3.14 AS production-dependencies

WORKDIR /app

COPY . .

RUN bun install --frozen-lockfile --production --filter @vibestart/backend

FROM oven/bun:1.3.14 AS runtime

WORKDIR /app

COPY --from=build /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/backend ./backend

WORKDIR /app/backend

ENV NODE_ENV=production

USER bun

# Joins the `edge` Docker network in the app's docker-compose.yml (added separately) so Caddy
# (infra/edge) can reverse-proxy to this container; not declared here since this Dockerfile only
# builds the image.
CMD ["bun", "src/index.ts"]
