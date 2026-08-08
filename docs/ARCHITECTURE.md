# Architecture

The deep reference for module boundaries, the request flow, the auth model, and the runtime shape.
`AGENTS.md`/`CLAUDE.md` summarize the rules an agent must follow; this document explains why they
exist and how the pieces fit together. Per-surface operational detail (env vars, commands, testing)
stays in each workspace's own README — this file cross-links rather than repeating it.

## Monorepo shape

Four Bun workspaces (`packages/contracts`, `backend`, `webapp`, `website`) plus `infra/*` Docker
Compose stacks that are not part of the Bun workspace graph. `packages/contracts` is the one
package every runtime surface can depend on; nothing else is shared code — `backend`, `webapp`, and
`website` do not import each other.

## Backend module architecture

`backend/src/modules/<context>/` — one directory per bounded context (currently `auth-context`,
`users`). Each module exposes its public surface only through `index.ts`; everything else inside
the module is a private implementation detail to the rest of the backend.

```
transport/        Hono routes. Translates HTTP <-> application calls. No Prisma, no provider SDKs.
application/       Use-case orchestration (services, ports). No Hono, Prisma, env, or provider SDKs.
domain/            Pure business rules, only when real rules exist. Same restrictions as application.
infrastructure/    Prisma repositories, provider SDK calls. Implements the ports application defines.
```

Dependency direction is one-way: `transport → application → domain`, with `infrastructure`
implementing ports that `application` declares (dependency inversion, not a direct import).
`transport` and `infrastructure` never import each other directly.

`scripts/architecture-check.mjs` enforces this statically (regex-based import scanning, not a full
parser — deliberately conservative, see the file's own header comment) as part of `bun run test`:

- `application`/`domain` importing Prisma, Hono, `env`, or a provider SDK (`hono`, `jose`, `pg`,
  `@prisma/*`, `react*`, `expo-*`) is a violation.
- `transport` importing Prisma or a provider SDK (`@prisma/*`, `jose`, `pg`) is a violation.
- A module reaching into another module's non-`index.ts` file is a violation — cross-module imports
  go through the public `index.ts` only.
- An "outer" layer being imported by an "inner" one (e.g. `domain` importing something resolved to
  `transport`) is a violation, regardless of the specifier's forbidden-package list.

`src/index.ts` starts the API server. `src/cron.ts`, `src/scheduler.ts`, `src/worker.ts` are the
three background-job entrypoints (see "Background jobs" below), all built on `src/runtime.ts`
(loads env, creates the Prisma client, owns background-task/Prisma cleanup). `src/app.ts` is the
API composition root: CORS, secure headers, health endpoints, module wiring, route mounting, OpenAPI
output. `src/db.ts` creates the Prisma client and holds the two Postgres advisory-lock helpers
(`runWithJobLock`, `acquireUserRoleMutationLock`). Full detail: `backend/README.md`.

## Webapp module architecture

`webapp/src/features/<context>/` — one directory per product feature (currently `auth`, `admin`,
`users`, `navigation`, `settings`). Same public-`index.ts`-only rule for cross-feature imports.

`src/platform/` (framework-agnostic capabilities — the authenticated HTTP transport, the Supabase
client) and `src/components/ui/` (shadcn/ui primitives) sit *below* features: neither may import a
product feature. Compose the other direction — a feature imports `platform`/`ui`, never the
reverse. `authenticated-transport.ts` is the concrete example: it takes generic
`getAccessToken`/`refreshAccessToken` functions and knows nothing about Supabase; `features/auth`
is what injects the supabase-js-backed implementations.

Routes/pages compose feature public APIs; they do not contain business logic themselves. The same
`architecture-check.mjs` script enforces the feature-boundary and platform-direction rules for both
`webapp/src` and `website/src`.

## Contracts

`packages/contracts/src/` — Zod schemas and inferred TypeScript types for every API payload, DTO,
and error shape, exported from `src/index.ts`. Backend routes and webapp API calls both import from
here instead of redefining shapes locally. `contracts` must not import backend, client, framework,
or provider code (enforced by `architecture-check.mjs`) — it stays pure data validation and
normalization, no runtime business logic.

## Request flow

**Authentication** happens entirely between the browser and Supabase, never through the backend:

```
Browser --(email/password)--> Kong --> GoTrue (auth)
                                          |
                              Supabase-issued JWT (HS256)
                                          |
Browser <-------------------------------- 
```

**Every other request** carries that JWT to the backend as a bearer token:

```
Browser --Authorization: Bearer <jwt>--> Backend
                                            |
                              1. Verify signature (SUPABASE_JWT_SECRET)
                              2. Check iss/aud/role/exp (SUPABASE_JWT_ISSUER)
                              3. Read profiles.role fresh from Postgres (never from the JWT)
                              4. Attach { id, email, role, displayName } to c.var.user
                                            |
                                    Route handler runs
```

`src/modules/auth-context` owns steps 1–4 (`requireAuth`, `requireAdmin` middleware). On first
sight of a `sub` with no `profiles` row, it provisions one (`role: user`) — this replaces a
database trigger on `auth.users`, since GoTrue owns that schema and backend tests must run without
it present. See `backend/README.md` ("How auth works") for the byte-level detail, including why
there is no session revocation on a role change.

## Auth model, in full

Supabase Auth (self-hosted GoTrue) is the single source of truth for *who is signed in*. The
backend is the single source of truth for *what they're allowed to do* — `profiles.role`, read
fresh on every request. This split means:

- The backend never writes to `auth.users` (Supabase owns it) except one deliberate, read-only,
  raw-SQL join in `admin-users-repository.ts` for the admin directory.
- `profiles` deliberately has no `email` column.
- A role change takes effect on the very next request with the same access token — there is no
  token to revoke, because the backend never issued one.
- Client-side, `@supabase/supabase-js` owns the whole session lifecycle (signup, login, logout,
  password reset, token storage, automatic refresh); `webapp/src/features/auth/provider.tsx` is the
  client-side golden path that mirrors that session into React state and fetches `/api/users/me`
  once one exists.

## Runtime shape

Production is one VPS running four Docker Compose stacks over two shared Docker networks (`edge`
and the narrower `app_edge` - see "Network segmentation" below), plus two static builds Caddy
serves through a versioned release directory:

```
                              Internet
                                 |
                            80 / 443 / 443-udp
                                 v
                   infra/edge (caddy: edge + app_edge)
                    /                        \
          releases/current              backend:3000   kong:8000
          (bind mount - webapp/website    (app_edge)     (edge, infra/supabase)
           dist inside)                       |               |
                                               v               v
                                        infra/app         infra/supabase
                                        backend       -->  db, auth, rest,
                                        (supabase net)      realtime, storage,
                                                             meta, studio, kong
```

Only `infra/edge` has ports open to the internet (80/443). `infra/supabase` binds every published
port to `127.0.0.1`; `infra/supabase`'s `kong` service joins the `edge` network (so Caddy can reach
it), while `infra/app`'s `backend` service instead joins the narrower `app_edge` network (shared
only with Caddy) - a compromised `backend` can reach Caddy but not `kong` or anything else on
`edge`. See `infra/app/README.md`, "Network segmentation". Full topology, the VPS bootstrap
checklist, and the network diagram: `infra/README.md`. Deploy runbook: `docs/DEPLOYMENT.md`.

## Data model conventions

- Every app table other than `profiles` generates its own primary key via the hand-written
  `uuidv7()` SQL function (Postgres 17 has no built-in one): `id String @id
  @default(dbgenerated("uuidv7()")) @db.Uuid`.
- `profiles.id` mirrors `auth.users.id` — no `@default`, no foreign key into the `auth` schema
  (GoTrue owns that schema; backend unit tests must run without it present).
- Migrations run as `supabase_admin` (the actual Postgres superuser in this image), never
  `postgres` — see `backend/README.md`, "Runtime DB role", for why the wrong identity silently
  no-ops the `auth`-schema grants a migration needs.
- The running application connects as `backend_runtime`, a least-privileged role activated by hand
  (`NOLOGIN` until an operator sets a password) — see `backend/README.md` and `docs/DEPLOYMENT.md`.

## See also

- `backend/README.md`, `webapp/README.md`, `website/README.md`, `packages/contracts/README.md` —
  per-surface commands, env vars, and conventions.
- `infra/README.md` — network topology and VPS bootstrap.
- `docs/DEPLOYMENT.md`, `docs/TESTING.md`, `docs/BACKUPS.md`, `docs/SUPABASE.md` — the other
  cross-cutting references.
