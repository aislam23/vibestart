# infra/app

Production compose stack for vibestart's own services - currently just the
Bun+Hono backend API (`backend/`). Not internet-facing on its own: Caddy
(`infra/edge`) reverse-proxies to it by Docker service name over the shared
`edge` network (see `infra/edge/Caddyfile`'s `{$API_DOMAIN}` block), and this
stack separately joins the `supabase` network so the backend can reach
Postgres and Kong by service name (`db`, `kong`) - see `infra/README.md`'s
topology diagram for the full picture.

Unlike `infra/supabase`/`infra/edge`/`infra/backup`, this stack does not
build its own image locally by default - `image: ${BACKEND_IMAGE:?}` always
points at an already-published `ghcr.io/<owner>/<repo>-backend:<tag>`
reference, pushed by `.github/workflows/deploy.yml`'s `build-push` job. Build
locally only to test the image itself (see "Local testing loop" below).

## What's in the stack

| Service | Image | Role |
|---|---|---|
| `backend` | `${BACKEND_IMAGE}` (built from `backend/Dockerfile`) | API - joins `app_edge` (reached by Caddy) and `supabase` (reaches Postgres/Kong) |
| `migrate` | `${BACKEND_IMAGE}`, profile `migrate` | One-shot `prisma migrate deploy` (`bun run prisma:deploy`) - the only service that receives `MIGRATE_DATABASE_URL`. Never `up`, never long-running - see "Migrations" below. |
| `scheduler` (commented out) | same image, `bun run start:scheduler` | Long-running background-job scheduler - see `backend/README.md`, "Background jobs". Empty registry by default; leave commented until a real scheduled job exists. |

No published ports on any service - `backend` is reached exclusively
through Caddy's `reverse_proxy backend:3000` (matching this compose file's
service name, which Docker resolves on the narrower `app_edge` network -
see "Network segmentation" below - without any extra alias configuration).

## Network segmentation

`backend` joins `app_edge` (shared with exactly infra/edge's `caddy`
service), not the broad `edge` network that `infra/supabase`'s `kong` and
any future edge-facing service also join. A compromised `backend` container
can therefore reach Caddy (needed, since Caddy reverse-proxies to it) and
Postgres/Kong (needed, via `supabase`), but not anything else that happens
to be on the wider `edge` network. `infra/edge/docker-compose.yml` joins
both `edge` (to reach `kong`) and `app_edge` (to reach `backend`) - Caddy
itself is the one service trusted to bridge both. Both networks are
provisioned the same way (`make ensure-network` / `docker network create
app_edge`) - see `infra/README.md`.

## Env

`cp .env.example .env`, fill in real values - see the comments in
`.env.example` for the full explanation of each variable (they map 1:1 to
`backend/src/env.ts`; see `backend/README.md`'s "Env" table for what each one
does at the application level). The two that are easy to get wrong:

- **`DATABASE_URL`/`MIGRATE_DATABASE_URL`** use `db:54322`, not `db:5432` -
  `infra/supabase` deliberately runs Postgres on port 54322 both on the host
  *and* inside the container (unlike `backend/docker-compose.test.yml`'s
  throwaway `db_test`, which pins the standard 5432). Confirmed against
  `infra/supabase/docker-compose.yml`'s own healthcheck, which relies on the
  `PGPORT` env var rather than passing `pg_isready -p` explicitly.
- **`SUPABASE_URL` vs `SUPABASE_JWT_ISSUER`** are deliberately different
  URLs: `SUPABASE_URL` is the internal `http://kong:8000` (Docker
  service-name resolution, no round-trip through the public internet),
  while `SUPABASE_JWT_ISSUER` must be GoTrue's **public** `https://<SUPABASE_DOMAIN>/auth/v1`
  - GoTrue signs the `iss` claim on every token with its own external URL,
  and a mismatch here rejects every request. See `.env.example`'s comments
  for the full reasoning.
- **`DATABASE_URL` needs `backend_runtime` activated before `backend` can
  connect at all.** `.env.example`'s default already points at
  `backend_runtime` (not `postgres`) - see "Migrations" and
  `docs/DEPLOYMENT.md`, "First-run order", for the exact one-time
  `ALTER ROLE backend_runtime LOGIN PASSWORD ...` step this requires.

## Migrations

`prisma migrate deploy` runs from the same published image as `backend`,
but as a **separate `migrate` service** - `command: ["bun", "run",
"prisma:deploy"]`, profile `migrate`, `restart: "no"` - so it is never part
of `docker compose up`'s default service set and is the only service that
ever receives `MIGRATE_DATABASE_URL` (the superuser connection). `backend`
itself only ever gets `DATABASE_URL` (`backend_runtime`, no DDL rights) -
see the compose file's `backend`/`migrate` service comments and
`docs/DEPLOYMENT.md`, "First-run order", for why this split exists.

```bash
make app-migrate
# equivalent: docker compose -f infra/app/docker-compose.yml run --rm migrate
```

Applies `backend/prisma/migrations` and exits. Run it after `infra/supabase`
is up, after `backend_runtime` is activated as a login role (see
`docs/DEPLOYMENT.md`), and before `make app-up` on a first deploy, and again
after every deploy that adds a new migration (see the deploy order below
and `.github/workflows/deploy.yml`, whose `deploy` job runs `docker compose
run --rm migrate` before rolling `backend` to a new image).

## Deploying from CI

`.github/workflows/deploy.yml` never touches `infra/app/.env` on the VPS -
that file holds the real secrets (`DATABASE_URL`, `SUPABASE_JWT_SECRET`,
...) and is maintained by hand, once, outside of git and outside of CI.
Instead, the `deploy` job writes a second, minimal, gitignored file next to
it, `infra/app/image.env`, containing only the freshly-built image
reference - **by immutable digest, not a mutable tag**:

```bash
# written atomically (unique temp file + mv) by the deploy workflow, on every run
BACKEND_IMAGE=ghcr.io/<owner>/<repo>-backend@sha256:<digest>
```

The compose file it runs against also comes from CI, versioned: every
deploy first `rsync`s this commit's `infra/` tree (and `Makefile`) to
`$DEPLOY_PATH/releases/<sha>/` on the VPS - see
`.github/workflows/README.md`, "Release layout on the VPS" - so the exact
compose definition a release runs with ships atomically with the code that
needs it. The workflow then runs `docker compose` with **that versioned
compose file** plus **both** env files, in this order:

```bash
docker compose -f "$DEPLOY_PATH/releases/<sha>/infra/app/docker-compose.yml" \
  --env-file "$DEPLOY_PATH/infra/app/.env" --env-file "$DEPLOY_PATH/infra/app/image.env" \
  pull backend migrate
# ... run --rm migrate, then up -d backend - same -f/--env-file trio
```

`--env-file` can be repeated; when the same key appears in more than one,
the last one wins (Compose v2.24+ - check `docker compose version` on the
VPS if this ever behaves unexpectedly on an older install). `image.env`
only ever sets `BACKEND_IMAGE`, so it overrides just that one value; every
other variable still comes from the persistent `.env`. After `up -d`, the
workflow polls `docker inspect --format '{{.State.Health.Status}}'` against
`docker compose ps -q backend`'s output (not a hardcoded container name -
see `CHECKLIST.md`'s rename step) until it reports `healthy` or a budget
runs out, printing the container's last 100 log lines, **rolling the
backend back to the previous image**, and failing the job if it never does
- see the workflow's inline comments for the exact rollback behavior. Only
once the new backend is healthy does the workflow flip
`$DEPLOY_PATH/current` to the new release, atomically.

`make app-up`/`make app-migrate` (manual, local use) don't know about any
of the above - they read `infra/app/docker-compose.yml` and
`infra/app/.env` directly from wherever they're run (the git checkout
itself, not a versioned `releases/<sha>/`), so `.env`'s own `BACKEND_IMAGE`
line (from `.env.example`) should stay up to date by hand for anyone
operating the stack outside of CI. See `docs/DEPLOYMENT.md`, "First-run
order", for how these two paths (CI's versioned releases vs. a plain
manual checkout) fit together on a fresh VPS.

## First deploy order

See `docs/DEPLOYMENT.md`, "First-run order", for the full sequence
including DNS/firewall/secrets - summary of the `infra/app`-specific steps,
which must happen in this order or `backend` will not start:

1. `cp infra/app/.env.example infra/app/.env`, fill in real values (and
   `infra/edge/.env` too, if this is the very first deploy - see
   `infra/edge/README.md`), `chmod 600 infra/app/.env`.
2. `make ensure-network && make supabase-up`.
3. `make app-migrate` - applies the schema (including the migration that
   creates `backend_runtime`, still `NOLOGIN` at this point) before the app
   ever starts serving traffic. Deliberately **not** part of the `make up`
   chain (a schema migration is never something a routine restart should
   run silently) - always run it by hand, once per deploy that includes a
   new migration.
4. **Activate `backend_runtime`** - `.env.example`'s `DATABASE_URL` default
   already points at this role, so `backend` cannot connect until it's an
   actual login role:
   ```sql
   ALTER ROLE backend_runtime LOGIN PASSWORD '<generated>';
   ```
   run once as a superuser (`supabase_admin`) against the target database,
   then make sure `infra/app/.env`'s `DATABASE_URL` password matches.
5. `make up` (or just `make app-up && make edge-up` if supabase is already
   running) - brings up `app` and `edge`. Routine restarts afterwards are
   just `make up` / `make down`, which cover all three stacks together.

This manual sequence uses the plain git checkout's `infra/app/docker-compose.yml`
directly - it does not go through the versioned `releases/<sha>/` layout
`.github/workflows/deploy.yml` maintains (see "Deploying from CI" above).
Both can coexist on the same VPS; whichever ran most recently is what's
actually running.

## Local testing loop

Build the image locally instead of pulling from GHCR, to test a change to
`backend/` end-to-end before pushing:

```bash
docker build -f backend/Dockerfile -t vibestart-backend:local .   # from the repo root

make supabase-up
cp infra/app/.env.example infra/app/.env   # then edit: BACKEND_IMAGE=vibestart-backend:local,
                                            # MIGRATE_DATABASE_URL's password from infra/supabase/.env,
                                            # SUPABASE_JWT_SECRET from infra/supabase/.env
make ensure-network                        # `app_edge` network, needed even without infra/edge running
make app-migrate                           # creates backend_runtime (still NOLOGIN)
docker compose -f infra/supabase/docker-compose.yml exec db psql -U supabase_admin -c \
  "ALTER ROLE backend_runtime LOGIN PASSWORD 'local-dev-only';"
# then edit infra/app/.env: DATABASE_URL=postgresql://backend_runtime:local-dev-only@db:54322/postgres
make app-up
docker inspect --format '{{json .State.Health}}' vibestart-backend
docker run --rm --network app_edge curlimages/curl -sf http://backend:3000/health/ready

make app-down
make supabase-down
rm infra/app/.env
```

`SUPABASE_JWT_ISSUER` can be left as the placeholder for this local loop
(no real GoTrue tokens are being verified) - it only matters once real
traffic through `infra/edge`/a real Supabase project is involved.

## Rollback

Previous image digests stay in GHCR - every CI build is content-addressed
(`docker/build-push-action` captures the pushed digest; see
`.github/workflows/deploy.yml`) and every deploy's `image.env` records
exactly which digest is live. Two options:

- **Re-run the workflow** with `workflow_dispatch` against an older,
  already-validated commit SHA (must still be an ancestor of `main` with a
  successful `ci.yml` run - see `.github/workflows/README.md`, "Deploy
  target validation") - the safest path, since it goes through the same
  health-gated, auto-rollback-on-failure release flow as a forward deploy.
- **Manual, on the VPS**: point `BACKEND_IMAGE` at a known digest and
  restart just that service:
  ```bash
  # infra/app/.env: BACKEND_IMAGE=ghcr.io/<owner>/<repo>-backend@sha256:<previous-digest>
  docker compose -f infra/app/docker-compose.yml pull backend
  docker compose -f infra/app/docker-compose.yml up -d backend
  ```
  A deploy's failed-health rollback (see "Deploying from CI" above) already
  does this automatically - use the manual path only for a rollback CI
  itself can't reach (e.g. rolling back hours after a deploy that later
  turned out to be bad).

Rolling back a schema migration is a separate, manual decision - `prisma
migrate deploy` has no built-in "down" - see Prisma's own docs on writing a
compensating migration if a rollback needs one.

## Validation

```bash
cd infra/app
docker compose config -q            # should FAIL - BACKEND_IMAGE is unset
cp .env.example .env
docker compose --env-file .env config -q   # should exit 0 (networks don't need to exist for `config`)
rm .env
```
