# Backend

The backend owns business logic, persistence, and the API. It does **not** own authentication:
Supabase Auth (self-hosted GoTrue, see `infra/supabase`) handles signup/login/token issuance
directly with the browser. The backend only verifies the Supabase-issued JWT on each request and
reads the app-level role (`user | admin`) from its own `profiles` table in Postgres - never from
JWT claims - so a role change takes effect on the very next request instead of waiting for a token
to expire. Product contexts live under `src/modules/<context>` and expose only `index.ts` across
context boundaries (`transport` → `application` → optional `domain`/`infrastructure`), following
the same module shape as the rest of the repository. Every app table other than `profiles`
generates its own primary key with the `uuidv7()` SQL function created in the first migration
(`prisma/migrations/*_init`) - use `id String @id @default(dbgenerated("uuidv7()")) @db.Uuid` for
new models; `profiles` is the one exception, since its id mirrors `auth.users.id`.

## Stack

- Bun
- Hono (`@hono/zod-openapi`)
- Prisma 7
- PostgreSQL (self-hosted Supabase, `infra/supabase`)
- Zod
- jose (Supabase JWT verification)
- TypeScript

## Env

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Points at the Supabase Postgres instance, e.g. `postgresql://postgres:PASSWORD@localhost:54322/postgres`. Copy the password from `infra/supabase/.env`. |
| `SUPABASE_URL` | yes | Public URL of the Supabase stack (Kong), e.g. `http://localhost:54321`. |
| `SUPABASE_JWT_SECRET` | yes, ≥32 chars | Shared HS256 secret GoTrue/PostgREST/Realtime/Storage all sign and verify with. Copy `JWT_SECRET` from `infra/supabase/.env`. |
| `SERVICE_ROLE_KEY` | no | Only needed once a module calls Supabase's admin API directly. Never expose to a browser client. |
| `PORT` | no, default `3000` | |
| `CORS_ORIGINS` | no | Comma-separated exact browser origins (no wildcards, no paths); must be HTTPS-only when `NODE_ENV=production`. |
| `SHUTDOWN_GRACE_SECONDS` | no, default `20` | Shared budget for draining background tasks and stopping the HTTP server. |
| `TRUST_PROXY` | no, default `false` | When `true`, requires `TRUSTED_PROXY_CLIENT_IP_HEADER`. |
| `TRUSTED_PROXY_CLIENT_IP_HEADER` / `_POSITION` | conditional | Required together with `TRUST_PROXY=true`; `POSITION` picks `first` or `last` of a comma-separated proxy chain. |

Copy `backend/.env.example` to `backend/.env` for local development.

## How auth works

1. The browser signs up/logs in directly against Supabase Auth (GoTrue, via `infra/supabase`) and
   gets back a Supabase-issued access token (HS256 JWT).
2. The browser sends that token as `Authorization: Bearer <jwt>` to the backend.
3. `src/modules/auth-context` verifies the signature with `SUPABASE_JWT_SECRET`, requires
   `aud`/`role` to be `authenticated` and the token to be unexpired, and reads `sub` as the user id.
4. On first sight of a `sub` with no `profiles` row, it provisions one (`role: user`, `displayName`
   from the JWT's `user_metadata.display_name` if present) - this replaces a database trigger on
   `auth.users`, since GoTrue owns that schema and backend tests must run without it.
5. The resulting `{ id, email, role, displayName, createdAt }` principal is attached to the request
   context (`c.var.user`); route handlers never touch Prisma directly for who-is-this-user
   questions.

There are no cookies and no `/api/auth/*` routes on the backend - CORS runs with
`credentials: false`.

## Dev loop

```bash
# from the repo root
bun run secrets:generate         # once, generates infra/supabase/.env
make supabase-up                 # or: cd infra/supabase && docker compose up -d
cp backend/.env.example backend/.env   # then fill in DATABASE_URL / SUPABASE_JWT_SECRET
bun install
bun run --cwd backend prisma:migrate   # applies prisma/migrations, creates uuidv7()
bun run --cwd backend dev
```

Root workspace aliases: `bun run dev:backend`, `bun run build:backend`, `bun run typecheck:backend`,
`bun run test:backend`.

## Commands

Run from the repository root unless noted:

```bash
bun run --cwd backend dev
bun run --cwd backend typecheck
bun run --cwd backend test
bun run --cwd backend start
bun run --cwd backend prisma:generate
bun run --cwd backend prisma:migrate
bun run --cwd backend prisma:deploy
bun run --cwd backend prisma:validate
```

`bun run --cwd backend test` runs the full unit test suite (no database required - every module
test uses a fake Prisma client or a `jose`-signed test JWT). There are no database-gated tests in
this skeleton; DB reality is instead verified by actually applying `prisma/migrations` and booting
the app against the real `infra/supabase` Postgres.

## Architecture

`src/index.ts` starts the API server. `src/runtime.ts` loads env, creates the Prisma client, and
owns background-task/Prisma cleanup - shared by the API today and by future worker/cron entrypoints.
`src/app.ts` is the composition root: CORS, secure headers, health endpoints, module wiring, route
mounting, and OpenAPI output. `src/env.ts` validates environment variables with Zod. `src/db.ts`
creates the Prisma client and normalizes DigitalOcean-style `sslmode=require` URLs for the Prisma
PostgreSQL adapter; `runWithJobLock` is a Postgres advisory-lock helper for the background jobs a
follow-up task adds. `src/modules/auth-context` is the authentication/principal golden path
described above. `src/modules/users` owns the current user's own profile (`GET /api/users/me`,
`PATCH /api/users/me`); admin directory reads and role changes are a follow-up module. Transport
must not import Prisma; application and domain must not import Hono, Prisma, env, or provider SDKs;
infrastructure implements context-specific ports. Routes stay thin and translate HTTP into
application calls and application failures into the stable API error shape from
`@vibestart/contracts`.

Prisma migration SQL is not written by hand for schema changes - change `prisma/schema.prisma`,
then run `bun run --cwd backend prisma:migrate`. The one exception is the `uuidv7()` function
itself, which is plain SQL prepended to the first migration (Postgres 17, the self-hosted Supabase
image's version, has no built-in `uuidv7()`).

## Current Upstream Documentation

- [Bun docs](https://bun.sh/docs)
- [Hono docs](https://hono.dev/docs)
- [Hono Zod OpenAPI example](https://hono.dev/examples/zod-openapi)
- [Prisma docs](https://www.prisma.io/docs)
- [Prisma migrations](https://www.prisma.io/docs/orm/prisma-migrate)
- [PostgreSQL docs](https://www.postgresql.org/docs/)
- [Zod docs](https://zod.dev/)
- [jose documentation](https://github.com/panva/jose)
- [Supabase self-hosting docs](https://supabase.com/docs/guides/self-hosting)
