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
| `DATABASE_URL` | yes | Points at the Supabase Postgres instance, e.g. `postgresql://postgres:PASSWORD@localhost:54322/postgres`. Copy the password from `infra/supabase/.env`. This is the connection the *running app* uses - see "Runtime DB role" below for switching it to a least-privileged role in production. |
| `MIGRATE_DATABASE_URL` | no | Superuser connection `prisma migrate`/`prisma migrate deploy` use for schema changes. Falls back to `DATABASE_URL` when unset. See "Runtime DB role". |
| `SUPABASE_URL` | yes | Public URL of the Supabase stack (Kong), e.g. `http://localhost:54321`. |
| `SUPABASE_JWT_SECRET` | yes, ≥32 chars | Shared HS256 secret GoTrue/PostgREST/Realtime/Storage all sign and verify with. Copy `JWT_SECRET` from `infra/supabase/.env`. |
| `SUPABASE_JWT_ISSUER` | no | The `iss` claim GoTrue stamps on tokens it issues. Defaults to `${SUPABASE_URL}/auth/v1`. In production this must equal GoTrue's *external* auth URL, e.g. `https://supabase.example.com/auth/v1`, not an internal/Docker hostname. |
| `SERVICE_ROLE_KEY` | no | Only needed once a module calls Supabase's admin API directly. Never expose to a browser client. |
| `PORT` | no, default `3000` | |
| `CORS_ORIGINS` | no | Comma-separated exact browser origins (no wildcards, no paths); must be HTTPS-only when `NODE_ENV=production`. |
| `SHUTDOWN_GRACE_SECONDS` | no, default `20` | Shared budget for draining background tasks and stopping the HTTP server. |
| `ADMIN_USERS_READ_RATE_LIMIT_MAX` / `_WINDOW_SECONDS` | no, default `120` / `60` | Independent rate-limit budget for `GET /api/admin/users`, keyed by administrator id. |
| `TRUST_PROXY` | no, default `false` | When `true`, requires `TRUSTED_PROXY_CLIENT_IP_HEADER`. |
| `TRUSTED_PROXY_CLIENT_IP_HEADER` / `_POSITION` | conditional | Required together with `TRUST_PROXY=true`; `POSITION` picks `first` or `last` of a comma-separated proxy chain. |

Copy `backend/.env.example` to `backend/.env` for local development.

## How auth works

1. The browser signs up/logs in directly against Supabase Auth (GoTrue, via `infra/supabase`) and
   gets back a Supabase-issued access token (HS256 JWT).
2. The browser sends that token as `Authorization: Bearer <jwt>` to the backend.
3. `src/modules/auth-context` verifies the signature with `SUPABASE_JWT_SECRET`, requires `iss` to
   match `SUPABASE_JWT_ISSUER` (binding verification to this specific Supabase project, not just to
   "any HS256 token signed with the shared secret"), `aud`/`role` to be `authenticated`, `iss`/`aud`/
   `sub`/`iat`/`exp` to all be present, and the token to be unexpired, and reads `sub` as the user id.
4. On first sight of a `sub` with no `profiles` row, it provisions one (`role: user`, `displayName`
   from the JWT's `user_metadata.display_name` if present) - this replaces a database trigger on
   `auth.users`, since GoTrue owns that schema and backend tests must run without it.
5. The resulting `{ id, email, role, displayName, createdAt }` principal is attached to the request
   context (`c.var.user`); route handlers never touch Prisma directly for who-is-this-user
   questions.

There are no cookies and no `/api/auth/*` routes on the backend - CORS runs with
`credentials: false`.

## Admin API

`src/modules/users` also owns the admin surface, gated by `requireAdmin`
(`src/modules/auth-context/middleware.ts`), which runs after `requireAuth` and checks the
already-fresh `c.var.user.role`:

- `GET /api/admin/metrics` - `{ totalUsers, totalAdmins, newUsersLast7Days }`. `totalAdmins` counts
  only *active* administrators - `profiles` joined with `auth.users` - not bare `profiles` rows; see
  "Recovery" below for the one case that excludes.
- `GET /api/admin/users` - paginated, searches email and display name (bounded `ILIKE` scan - fine
  for a small user base; at real scale, add a trigram index (`pg_trgm`) or another search strategy,
  and move the rate limiter's in-memory state to something shared once this runs on more than one
  backend instance), rate-limited independently (`ADMIN_USERS_READ_RATE_LIMIT_MAX`/`_WINDOW_SECONDS`)
  keyed by administrator id.
- `PATCH /api/admin/users/:userId/role` - changes a user's role inside a transaction serialized by
  a Postgres advisory lock (`acquireUserRoleMutationLock`, `src/db.ts`), so two concurrent role
  changes can never leave zero administrators. Re-authorizes the actor *inside* that lock (reloads
  their profile and checks it is still `admin`) before applying anything, so a request that already
  passed `requireAuth`/`requireAdmin` before a concurrent demotion committed cannot still mutate a
  role once it is that actor's turn. The lock wait itself is bounded (`SET LOCAL lock_timeout =
  '5s'`); a request that waits longer than that gets `409 CONFLICT` with `Retry-After: 5` instead of
  hanging. Also rejects self-demotion and demoting the last *active* administrator (see above) with
  `409 CONFLICT`.

**No session revocation on a role change.** The source template this repository is based on
revokes sessions after a role change, because it issues and stores its own session tokens. This
backend never does that: Supabase issues and owns the access token, and `auth-context` re-reads
`profiles.role` on every single request (see "How auth works" above), so a role change already
takes effect on the *very next request* with the same token - there is nothing to revoke.

`profiles` deliberately has no `email` column - Supabase owns `auth.users` and this backend never
writes to it. The one exception is
`src/modules/users/infrastructure/admin-users-repository.ts`, which reads `auth.users` with a
raw, read-only SQL join for the admin directory only; nowhere else in the backend touches that
table.

**Recovery.** Because the admin directory and the last-admin invariant both use an inner join
against `auth.users`, a `profiles` row whose `auth.users` row was deleted (the auth-side account is
gone, but nothing here mirrors that deletion) becomes invisible to both - it can silently stop
counting as "an administrator remains" and stop showing up in `GET /api/admin/users`. If that
leaves zero *active* administrators, promote one directly through `psql`:
`UPDATE profiles SET role = 'admin' WHERE id = '<uuid>';`. A periodic job that reconciles orphaned
`profiles` rows against `auth.users` would be a good first real entry in the empty background-job
registry below - not implemented here.

## Background jobs

Work that runs outside any HTTP request. One registry (`src/jobs.ts`, `backgroundJobs`), three
processes that can run it:

| Process | Shape | Use it when |
| --- | --- | --- |
| `src/cron.ts` | One shot: runs a single named job, then exits. | A provider timer already exists (a scheduled job, a system crontab). |
| `src/scheduler.ts` | Long-running process, timers (`schedules`) inside. | Schedules should live in the repository; a VPS or a cloud worker component. |
| `src/worker.ts` | Long-running loop (`workerLoops`). | Work must run more often than once a minute, or several jobs side by side. |

All three ship **empty** - this template has no session table to sweep (Supabase Auth owns
sessions) and no other recurring work yet, so an install that never needs one pays nothing for it.
Uncomment the commented example in `jobs.ts` (and a runner) once a real job exists.

**Locking is the default for every runner, not something each one has to remember.** The registry
in `jobs.ts` takes a Postgres advisory lock (`runWithJobLock`, `src/db.ts`) around every job by
default, whether it is triggered by `cron.ts` (one shot), `scheduler.ts` (an in-process timer), or
`worker.ts` (a loop) - so a rolling deploy, a scaled-out worker, or two overlapping provider-timer
triggers of the same cron job cannot run the same job twice; the copy that loses the race logs that
it skipped. A job opts out of locking, once, on its own definition in `jobs.ts` - `{ run, parallel:
true }` - only when it is demonstrably safe to run more than once at a time (already idempotent, or
serialized by something else); a plain `(runtime, now, signal) => Promise<void>` function is always
locked.

**Jobs receive an `AbortSignal`.** Every job's third argument aborts when its lock/transaction times
out mid-run (the lock is gone, but the job's own code keeps executing until it awaits something
that fails) and when the runner is shutting down. It is cooperative, not forcible - a job that never
checks it (or never passes it down to whatever it awaits) never learns to stop, so write jobs that
are idempotent and that do check it. `scheduler.ts`'s and `worker.ts`'s shutdown waits for
in-flight jobs are themselves bounded by `SHUTDOWN_GRACE_SECONDS`: aborting the signal only *asks* a
job to stop, so a job that ignores it does not hang the whole process shutdown - the runner logs an
error and proceeds once the grace period elapses.

Run any job by hand: `bun run --cwd backend start:cron -- <job>`. See the doc comments in
`src/jobs.ts`, `src/scheduler.ts`, and `src/worker.ts` for lock timeouts and the trade-offs between
the three runners - the mechanism is a direct port of the source template's
`docs/BACKGROUND_JOBS.md`, only the starter registry (empty here) and the locking-by-default policy
differ.

```bash
bun run --cwd backend start:cron -- <job>
bun run --cwd backend start:scheduler
bun run --cwd backend start:worker
```

## Runtime DB role

The running application should connect as a least-privileged Postgres role, not the migration
superuser. The `backend_runtime_role` migration creates `backend_runtime`: CRUD (no DDL) on every
table in `public` (current and future, via `ALTER DEFAULT PRIVILEGES`), and read-only access to
exactly the `auth.users` columns the admin directory's join needs (`id`, `email`) - nothing else,
and never write access, since GoTrue owns that table.

The role is created `NOLOGIN`, so applying the migration alone does not switch anything over. To
activate it:

```sql
ALTER ROLE backend_runtime LOGIN PASSWORD '<generated>';
```

Generate `<generated>` yourself (e.g. `openssl rand -base64 32`) and run that statement once,
as a superuser, against the target database - `bun run secrets:generate` does **not** manage this
password. Then point `DATABASE_URL` at `backend_runtime` with that password, and set
`MIGRATE_DATABASE_URL` to the superuser connection so `prisma migrate`/`prisma migrate deploy` keep
working (see the Env table above). The integration test suite
(`bun run test:backend:integration`) activates and exercises this role automatically against the
throwaway `db_test` database, so `backend_runtime`'s privileges are covered by CI (see Testing
below), not just by this migration's SQL.

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
`bun run test:backend`, `bun run test:backend:integration`, `bun run smoke:backend:docker`,
`bun run architecture:check`.

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

## Testing

Three layers, each cheaper and faster than the next:

- **Unit** - `bun run --cwd backend test` (root alias: `bun run test:backend`). No database:
  every module test uses a fake Prisma client or a `jose`-signed test JWT. Runs as part of the
  root `bun run test`, alongside `bun run architecture:check` (root `scripts/architecture-check.mjs`,
  its own test: `bun run test:architecture`), which statically checks module boundaries and layering
  (transport must not import Prisma; application/domain must not import Hono, Prisma, env, or
  provider SDKs; cross-module imports only through a module's `index.ts`; `packages/contracts` must
  not import backend, client, framework, or provider code).
- **Integration** - `bun run --cwd backend test:integration` (root alias:
  `bun run test:backend:integration`, **CI must run this as its own step** - it needs Docker and
  takes longer than the unit suite). Starts a throwaway Postgres
  (`backend/docker-compose.test.yml`, service `db_test`, port `127.0.0.1:54329` - **not** the dev
  Supabase stack in `infra/supabase`, port `54322`), applies `prisma/migrations` as the migration
  superuser, activates the `backend_runtime` role (see "Runtime DB role" above) and runs every
  `*.integration.test.ts` file's app-facing requests through it, then tears the container down with
  `docker compose down --volumes` (the one place in the repository a `-v` teardown is correct:
  `db_test` never holds anything worth keeping). `backend/scripts/test-integration.mjs` refuses to
  run against anything that does not parse as `db_test`'s exact loopback host/port/database shape
  (override only with `DESTRUCTIVE_TEST_ACK=yes` and a loopback host), and creates a sentinel row it
  re-checks immediately before that teardown, so a misconfigured `TEST_DATABASE_URL` cannot point
  this script's one destructive step at the wrong database. `db_test` gets a minimal stub
  `auth.users(id, email)` table (`backend/scripts/test-db-init`) instead of running real Supabase
  Auth, just enough for the admin directory's read-only join to work against real Postgres; see the
  comment in that SQL file for why.
- **Docker smoke** - `bun run --cwd backend smoke:docker` (root alias:
  `bun run smoke:backend:docker`). Builds `backend/Dockerfile`, runs the image against `db_test`,
  and asserts `GET /health/ready` returns `200` - the same check a container orchestrator's
  readiness probe would make.

`GET /health/ready` caches its database probe for 5 seconds in-process (and collapses concurrent
callers during a cache miss onto one query) so a flood of readiness requests cannot multiply
`SELECT 1` queries; the endpoint itself stays public, behind the edge proxy like the rest of the
API - the cache is what bounds the database load, not an auth check.

## Architecture

`src/index.ts` starts the API server; `src/cron.ts`, `src/scheduler.ts`, and `src/worker.ts` are
the three background-job entrypoints (see "Background jobs" above), all built on the same
`src/runtime.ts`, which loads env, creates the Prisma client, and owns background-task/Prisma
cleanup. `src/app.ts` is the API composition root: CORS, secure headers, health endpoints, module
wiring, route mounting, and OpenAPI output. `src/env.ts` validates environment variables with Zod.
`src/db.ts` creates the Prisma client, normalizes DigitalOcean-style `sslmode=require` URLs for the
Prisma PostgreSQL adapter, and holds two Postgres advisory-lock helpers: `runWithJobLock` for
background jobs and `acquireUserRoleMutationLock` for admin role changes. `src/modules/auth-context`
is the authentication/principal golden path described above, plus `requireAdmin`. `src/modules/users`
owns both the current user's own profile (`GET`/`PATCH /api/users/me`) and the admin surface (see
"Admin API" above) behind one `UsersService`. Transport must not import Prisma; application and
domain must not import Hono, Prisma, env, or provider SDKs; infrastructure implements
context-specific ports; cross-module imports go through a module's `index.ts` only.
`scripts/architecture-check.mjs` at the repository root enforces all of this statically. Routes
stay thin and translate HTTP into application calls and application failures into the stable API
error shape from `@vibestart/contracts`.

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
