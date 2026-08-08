# vibestart

A full-stack starter template for a real product: **Bun + Hono** backend, a **React** CSR webapp,
an **Astro** marketing website, and a self-hosted **Supabase** stack, all deployed together on a
single VPS with Docker Compose. Apache-2.0, derived from the [Vibe Coding
Template](https://github.com/di-sukharev/vibe) (see `NOTICE`).

Auth is not hand-rolled: Supabase Auth (self-hosted GoTrue) owns signup, login, and token
issuance; the backend only verifies the Supabase-issued JWT and reads app-level roles from its own
database. Everything else — API, admin surface, background jobs, file storage, backups — is a
normal, ownable codebase, not a black box.

## Stack

| Surface | Stack |
| --- | --- |
| `backend` | Bun, Hono (`@hono/zod-openapi`), Prisma 7, PostgreSQL, Zod, `jose` |
| `webapp` | React, Vite, TypeScript, Tailwind CSS, shadcn/ui, Radix UI, TanStack Query/Form/Router, `@supabase/supabase-js` |
| `website` | Astro (static-first), Tailwind CSS 4, shadcn/ui (server-rendered via React), React Three Fiber (hero only) |
| `packages/contracts` | Zod schemas/DTOs shared by backend and clients |
| Auth & data | Self-hosted Supabase: Postgres, GoTrue (auth), PostgREST, Realtime, Storage, imgproxy, postgres-meta, Kong, Studio |
| Edge | Caddy (automatic TLS, reverse proxy, static file serving) |
| Backups | restic → S3-compatible storage, verified snapshots, retention rotation |
| CI/CD | GitHub Actions — test/build on every PR, build+deploy on a version tag |

Everything runs as Docker Compose stacks on one VPS. There is no managed-cloud deployment path
(no DigitalOcean App Platform, no Yandex Cloud, no serverless) — see `docs/DEPLOYMENT.md`.

## Monorepo map

```
packages/contracts   Shared Zod schemas/DTOs — the source of truth for API shapes
backend/             Bun + Hono API, Prisma, background jobs, Supabase JWT verification
webapp/              React CSR app behind sign-in (dashboards, admin, account)
website/             Astro static site (landing page, public/SEO surfaces)
infra/supabase/      Self-hosted Supabase stack (trimmed to what this template uses)
infra/edge/           Caddy — the only stack with ports open to the internet
infra/app/            Production compose stack for the backend image
infra/backup/         Scheduled, encrypted, verified Postgres backups to S3
.github/workflows/    CI (ci.yml) and deploy (deploy.yml)
docs/                 Cross-cutting reference docs (architecture, deployment, testing, backups, Supabase)
```

Each workspace and each `infra/*` stack has its own README with the operational detail for that
surface; this file is the map and the front door.

## Quick start (local)

```bash
bun install                              # once

make secrets                             # writes infra/supabase/.env (dev-friendly defaults)
make supabase-up                         # starts Postgres, GoTrue, PostgREST, Realtime, Storage, Kong, Studio

cp backend/.env.example backend/.env     # fill DATABASE_URL / SUPABASE_JWT_SECRET from infra/supabase/.env
bun run --cwd backend prisma:migrate     # applies backend/prisma/migrations, creates the uuidv7() function
bun run dev:backend                      # http://localhost:3000

cp webapp/.env.example webapp/.env       # fill VITE_SUPABASE_ANON_KEY from infra/supabase/.env
bun run dev:webapp                       # http://localhost:5173

bun run dev:website                      # http://localhost:4321 — no env required for local dev
```

Or, once every `.env` above exists, run all three dev servers together with `bun run dev` (root
`package.json`'s `--filter '*' --parallel dev`).

**Create a user.** Local dev has Supabase email autoconfirm on, so signing up through the webapp
(`/signup`) returns a session immediately — no SMTP needed. To make that user an admin:

```bash
docker exec -it $(docker compose -f infra/supabase/docker-compose.yml ps -q db) \
  psql -U postgres -c "UPDATE profiles SET role = 'admin' WHERE id = '<user-uuid-from-auth.users>';"
```

Stop everything with `make supabase-down` (keeps data) or reset it entirely with `docker compose -f
infra/supabase/docker-compose.yml down -v` (destroys it — see `infra/supabase/README.md`).

## webapp vs. website: which surface does a feature belong to?

This is an engineering decision, not a product one — a future agent should make this call, not
ask the user to.

- **`website`** — public, unauthenticated, must rank in search or preview well when shared: the
  landing page, marketing/content pages, anything SEO-critical. Astro, static-first, cheap to
  serve, no client JS by default.
- **`webapp`** — behind sign-in, no SEO requirement: dashboards, account settings, admin tools,
  anything that needs a live session. React CSR, talks to the backend with a bearer token.

Full auth in `website` is acceptable only for small public-site needs (a logged-in header state);
full account/admin/dashboard workflows stay in `webapp` unless they have a concrete SEO
requirement. See `website/README.md` ("Practice") and `webapp/README.md`.

## Deploy to a VPS

Production is one VPS running four Docker Compose stacks (`infra/supabase`, `infra/app`,
`infra/edge`, `infra/backup`) plus two static builds (`webapp/dist`, `website/dist`) that Caddy
serves from a versioned release directory. Deploys run in GitHub Actions
(`.github/workflows/deploy.yml`): validate the target commit → build the backend image by digest →
push to GHCR → SSH to the VPS → sync a versioned release bundle → run migrations → roll the backend
container → poll its healthcheck → flip the release live.

Start with `docs/DEPLOYMENT.md` for the full runbook (DNS, firewall, secrets, first-deploy order,
rollback); `infra/README.md` has the network topology and VPS bootstrap checklist;
`.github/workflows/README.md` lists every secret and variable the deploy workflow needs.

## Makefile command reference

Run `make help` for the live list. Every target works from any directory in the repo.

| Command | What it does |
| --- | --- |
| `make secrets` | Generate `infra/supabase/.env` for local dev (refuses to overwrite) |
| `make secrets-prod` | Generate `infra/supabase/.env` for production (`ARGS="--site-url=... --api-external-url=... --public-url=..."`) |
| `make ensure-network` | Create the shared `edge` Docker network if missing |
| `make supabase-up` / `supabase-down` / `supabase-logs` | Start / stop (keeps data) / tail the Supabase stack |
| `make edge-up` / `edge-down` | Start / stop the Caddy edge stack (production only) |
| `make app-up` / `app-down` / `app-logs` | Start / stop / tail the backend production stack |
| `make app-migrate` | Apply `backend/prisma/migrations` against `MIGRATE_DATABASE_URL` |
| `make up` / `down` | Start / stop all stacks in the correct order (network → supabase → app → edge, reversed for down) |
| `make status` | Container status for every stack + Docker volume disk usage |
| `make test` / `make typecheck` | `bun run test` / `bun run typecheck` across the whole repo |
| `make backup` | Run a one-shot Postgres backup to S3 now |
| `make restore` | List available backup snapshots (the actual restore command is deliberately not a Makefile target — see `infra/backup/README.md`) |
| `make backup-up` / `backup-down` | Start / stop the scheduled backup cron service |
| `make pre-restore-snapshot` | Host-side safety-net tar of the live Postgres volumes before a restore |
| `make deploy` | Not a local target — prints where deploy actually happens (`.github/workflows/deploy.yml`) |

## Testing

Four layers, each more expensive than the last. `docs/TESTING.md` has the full contract; the short
version:

```bash
bun run test                       # contracts + backend + webapp + website unit tests + architecture check
bun run test:backend:integration   # backend against a real throwaway Postgres (needs Docker)
bun run e2e:webapp                 # Playwright, full stack incl. a throwaway Supabase (needs Docker)
bun run smoke:backend:docker       # builds backend/Dockerfile, asserts GET /health/ready
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, `bun run test`, backend integration tests,
`bun run build`, and the webapp e2e suite on every PR and every push to `main`.

## Documentation

- `AGENTS.md` / `CLAUDE.md` — the operating standard for an AI agent working in this repository (identical content).
- `CHECKLIST.md` — the intake questionnaire and capability ledger for a project built from this template.
- `docs/ARCHITECTURE.md` — module boundaries, request flow, the auth model, runtime shape.
- `docs/DEPLOYMENT.md` — the full VPS deploy runbook.
- `docs/TESTING.md` — the unit/integration/e2e/architecture contract and what CI runs.
- `docs/BACKUPS.md` — backup/restore summary (source of truth: `infra/backup/README.md`).
- `docs/SUPABASE.md` — what's in the trimmed self-hosted Supabase stack and why.
- Every workspace and `infra/*` stack has its own README with the detail specific to that surface.

## License

Apache-2.0. Copyright 2026 Artem Islamov. This project is derived from the [Vibe Coding
Template](https://github.com/di-sukharev/vibe) by Dima Sukharev, also Apache-2.0 — see `NOTICE`
for the full attribution and `LICENSE` for the license text.
