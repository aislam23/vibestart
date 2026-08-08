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

# Joins the `edge` and `supabase` Docker networks in infra/app/docker-compose.yml (the compose
# project that actually runs this image in production) so Caddy (infra/edge) can reverse-proxy to
# this container and it can reach Postgres/Kong by service name; not declared here since this
# Dockerfile only builds the image.
CMD ["bun", "src/index.ts"]
