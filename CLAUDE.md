# CLAUDE.md

Operating standard for an AI coding agent (Claude Code, Codex, or similar) working in this
repository — either the vibestart template itself, or a project installed from it. Keep this file
and `AGENTS.md` identical; if you edit one, edit the other the same way.

## Operating principles

- Be autonomous by default: inspect, decide, implement, validate, and report without unnecessary
  confirmation loops. Ask only when ambiguity blocks a safe decision, a product choice is genuinely
  open, or the action is risky/destructive enough that the user should explicitly choose.
- Do not hallucinate. Verify uncertain claims against code, migrations, tests, or runtime output —
  not memory of "a typical Supabase/Prisma/Hono setup." This template's conventions (the runtime
  DB role, the auth model, the uuidv7 rule) are specific and easy to get subtly wrong by pattern-matching
  to a generic version.
- Preserve unrelated user work. Do not revert, reformat, or "clean up" code you did not touch as
  part of the current task.
- Trust current code, migrations, and tests over stale docs. If you find a doc that contradicts the
  code, fix the doc (or flag it) rather than propagating the mistake.
- Keep diffs focused. Run `bun run architecture:check` after any change that touches module,
  feature, contracts, or platform boundaries — it is also part of `bun run test`.

## Module architecture

**Backend** (`backend/src/modules/<context>/`): `transport` (Hono routes) → `application`
(use-case orchestration) → optional `domain` (pure rules) / `infrastructure` (Prisma, provider
SDKs). Rules, enforced statically by `scripts/architecture-check.mjs`:

- `transport` must not import Prisma or provider SDKs.
- `application`/`domain` must not import Hono, Prisma, env, or provider SDKs.
- Cross-module imports go through a module's `index.ts` only — never reach into another module's
  internal layers.
- `packages/contracts` must not import backend, client, framework, or provider code.

**Webapp** (`webapp/src/features/<context>/`): `platform/` and `components/ui/` never import
product features (they're the lower layer); cross-feature imports go through a feature's public
`index.ts`. Same `architecture:check` script enforces this for `webapp/src` and `website/src` too.

**Contracts** (`packages/contracts/`): the shared source of truth for API payloads, DTOs, and error
shapes. Add or change a schema here first, then update backend routes and client forms against it
— validate both the producer (backend) and every consumer (webapp, and any future client) in the
same pass.

See `docs/ARCHITECTURE.md` for the full module map, the request flow, and the runtime shape.

## Auth model

Supabase Auth (self-hosted GoTrue, `infra/supabase`) owns authentication end to end — signup,
login, logout, password reset, token issuance and refresh. The backend does **not** issue or store
sessions; there are no cookies and no `/api/auth/*` routes. It only:

1. Verifies the Supabase-issued JWT (`SUPABASE_JWT_SECRET`, HS256) on every request, binding to
   this specific Supabase project via the `iss` claim (`SUPABASE_JWT_ISSUER`).
2. Reads the app-level role (`user | admin`) from its own `profiles` table, fresh on every
   request — **never from the JWT**. A role change (promote/demote) takes effect on the very next
   request with the same token; there is nothing to revoke.

Never add a JWT claim, a cookie, or a custom session store to carry authorization — that duplicates
what Supabase and `profiles` already do, and it will drift out of sync with the DB-held role. See
`backend/README.md` ("How auth works") and `webapp/README.md` ("Auth architecture") for the full
mechanics.

## Data model conventions

- Every app table generates its own timestamp-ordered primary key with the hand-written
  `uuidv7()` SQL function (created in the first migration — Postgres 17 has no built-in one):
  `id String @id @default(dbgenerated("uuidv7()")) @db.Uuid`.
- **`profiles` is the one exception** — its `id` mirrors `auth.users.id` with no `@default`, since
  it's provisioned the first time a valid Supabase JWT is seen for a `sub` with no existing row.
- Do not hand-write migration SQL for schema changes — edit `backend/prisma/schema.prisma`, then run
  `bun run --cwd backend prisma:migrate`. Hand-written SQL is reserved for genuine exceptions (the
  `uuidv7()` function itself, the `backend_runtime` role grants, the `auth.users` RLS policy).

## Runtime database role vs. migration identity

Two different Postgres identities, never interchangeable:

- **Migrations** (`prisma migrate deploy`) run as `supabase_admin` — in this self-hosted Supabase
  Postgres image, `postgres` is *not* an actual superuser and lacks `GRANT OPTION` on the `auth`
  schema. Running a migration as `postgres` makes its `auth`-schema `GRANT`/policy statements
  silently no-op (a Postgres `WARNING`, not an error) — the migration reports success while leaving
  the runtime role unable to read `auth.users` at all.
- **The running app** connects as `backend_runtime`, a least-privileged role: CRUD (no DDL) on
  `public`, plus a column-restricted read-only grant on `auth.users(id, email)` for the admin
  directory join. It is `NOLOGIN` until activated by hand (`ALTER ROLE backend_runtime LOGIN
  PASSWORD '<generated>'`) — this is deliberately not automated.

`DATABASE_URL` (runtime) vs. `MIGRATE_DATABASE_URL` (superuser, falls back to `DATABASE_URL` when
unset) in `backend/src/env.ts`. See `backend/README.md` ("Runtime DB role") before touching either.

## Hosting reality

**One VPS, Docker Compose, self-hosted Supabase — that is the only deployment path this template
has.** There is no DigitalOcean App Platform, no Yandex Cloud, no managed-Postgres, no serverless
option. Do not introduce provider-specific tooling or docs for another hosting model unless the
user explicitly asks to add a new deployment path as a real, separate piece of work.

Four Docker Compose stacks (`infra/supabase`, `infra/app`, `infra/edge`, `infra/backup`) plus two
static builds (`webapp/dist`, `website/dist`) that Caddy bind-mounts. Deploy = GitHub Actions
(`.github/workflows/deploy.yml`) building the backend image, pushing to GHCR, then SSH-ing to the
VPS to sync static builds, run migrations, and roll the backend container. See
`docs/DEPLOYMENT.md`.

## Background jobs

One registry (`backend/src/jobs.ts`, `backgroundJobs`), three interchangeable runners
(`src/cron.ts` one-shot, `src/scheduler.ts` in-process timers, `src/worker.ts` a long-running
loop) — pick the runner the hosting model implies, don't invent a fourth. All three ship **empty**
by default; this template has no recurring work out of the box. Every job is wrapped in a Postgres
advisory lock by default (so a rolling deploy or a scaled-out worker can't run the same job twice)
unless it explicitly opts out with `{ run, parallel: true }` because it is already idempotent or
serialized elsewhere. See `backend/README.md` ("Background jobs").

## Storage

Supabase Storage (`infra/supabase`'s `storage`/`imgproxy` services), backed by either local disk
(`STORAGE_BACKEND=file`, dev default) or an S3-compatible bucket (`STORAGE_BACKEND=s3`, recommended
from day one in production — switching backends after objects exist requires a manual data
migration, not a config edit). No storage module, routes, or UI ship in the template yet — see
`CHECKLIST.md`'s capability ledger and `infra/supabase/README.md` ("Storage: local disk vs S3").

## Backups

`infra/backup` runs scheduled, encrypted, **verified** restic backups of Postgres to S3, with
retention rotation and a heartbeat. Restic password and S3 credentials are set up once by hand —
`bun run secrets:generate` does not manage them. **A backup that hasn't been restore-tested doesn't
exist** — run the restore drill quarterly. Full runbook: `infra/backup/README.md`; summary:
`docs/BACKUPS.md`.

## Testing expectations

Four layers, each pricier than the last:

- **Unit** (`bun run test`) — no database, no Docker. Runs `test:contracts`, `test:backend`,
  `test:webapp`, `test:website`, `test:architecture`, and `architecture:check` together. This is
  what CI's `test` job runs, plus `bun run typecheck`, `bun run lint`, and `bun run build`.
- **Backend integration** (`bun run test:backend:integration`) — a real throwaway Postgres
  (`backend/docker-compose.test.yml`), applies migrations, activates `backend_runtime`. Needs
  Docker; CI runs it as its own step.
- **Webapp e2e** (`bun run e2e:webapp`) — Playwright against a real, fully isolated Supabase stack
  + backend + Vite. Covers a handful of full journeys and RBAC redirects, not validation matrices —
  those live in backend integration tests and `webapp/tests`. Needs Docker; CI runs it as a
  separate job.
- **Docker smoke** (`bun run smoke:backend:docker`) — builds the real `backend/Dockerfile` and
  asserts `/health/ready` returns 200.

See `docs/TESTING.md` for the full contract and exactly what CI runs.

## Documentation discipline

- Update `README.md`/`docs/` when a change materially affects architecture, setup, deployment, or
  contracts. Don't create doc churn for a trivial refactor.
- Keep `AGENTS.md`/`CLAUDE.md` identical. If you find them diverged, that's a bug — fix it.
- `CHECKLIST.md`'s capability ledger is the record of what this specific project actually contains.
  A migration, a route, or a doc mention is not by itself a product requirement — update the ledger
  when a capability is genuinely added or removed, and don't build something the ledger marks
  `absent` without the product owner asking for it.

## Git and remote policy

- Inspect `git remote -v` before any branch, commit, push, or PR workflow.
- Treat a fresh checkout of this repository as a template for a new project, not as a source for
  contributing back to the template, unless the user says otherwise.
- If `origin` points at the template repository and the user hasn't said they're contributing to
  the template itself, detach it (`git remote remove origin`) during first-run setup (see
  "Bootstrap-Only Instructions" below).
- Add the user's own repository as `origin` only when they provide a URL or ask to publish.

## Bootstrap-Only Instructions

<!-- BOOTSTRAP_ONLY_START -->
This block exists only for a fresh install of this template. If this repository has not been
adopted for a real project yet:

- Run the `CHECKLIST.md` intake in the user's language before feature work starts — ask everything
  through *First-version capabilities*, decide everything under *Decided by the agent* yourself,
  and write the answers into that file as you go.
- Detach the template remote per "Git and remote policy" above, unless this checkout is explicitly
  for improving the template.
- Rename the project's identifiers away from `vibestart` (package names, `@vibestart/*` workspace
  references, Docker container/network names in `infra/*/docker-compose.yml`, GHCR image names in
  `.github/workflows/deploy.yml`) and regenerate `bun.lock` after.
- Run `make secrets` to generate fresh dev secrets — never reuse the template's own committed
  `.env.example` placeholder values for anything real.
- Record durable project choices (product, active surfaces, deployment domains, storage/SMTP
  provider) in `CHECKLIST.md`, not in this file.
- After first-run setup is complete, delete this entire `Bootstrap-Only Instructions` block from
  both `AGENTS.md` and `CLAUDE.md`.
<!-- BOOTSTRAP_ONLY_END -->
