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
| `backend` | `${BACKEND_IMAGE}` (built from `backend/Dockerfile`) | API - joins `edge` (reached by Caddy) and `supabase` (reaches Postgres/Kong) |
| `scheduler` (commented out) | same image, `bun run start:scheduler` | Long-running background-job scheduler - see `backend/README.md`, "Background jobs". Empty registry by default; leave commented until a real scheduled job exists. |

No published ports on either service - `backend` is reached exclusively
through Caddy's `reverse_proxy backend:3000` (matching this compose file's
service name, which Docker resolves on the shared `edge` network without any
extra alias configuration).

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

## Migrations

`prisma migrate deploy` runs from the same published image, against the
superuser (`MIGRATE_DATABASE_URL`) connection - never automatically on
`docker compose up`:

```bash
make app-migrate
# equivalent: docker compose -f infra/app/docker-compose.yml run --rm backend bun run prisma:deploy
```

This is a one-shot `run --rm`, not a service in the compose file - it starts
the image with the entrypoint's default `bun` prefix rewritten to `bun run
prisma:deploy` (see `backend/Dockerfile`'s `CMD` and the base `oven/bun`
image's passthrough entrypoint), applies `backend/prisma/migrations`, and
exits. Run it after `infra/supabase` is up and before `make app-up` on a
first deploy, and again after every deploy that adds a new migration (see
the deploy order below and `.github/workflows/deploy.yml`, which runs this
same command before rolling the `backend` service to a new image tag).

## Deploying from CI

`.github/workflows/deploy.yml` never touches `infra/app/.env` on the VPS -
that file holds the real secrets (`DATABASE_URL`, `SUPABASE_JWT_SECRET`,
...) and is maintained by hand, once, outside of git and outside of CI.
Instead, the deploy job writes a second, minimal, gitignored file next to
it, `infra/app/image.env`, containing only the freshly-built image
reference:

```bash
# written atomically (tmp file + mv) by the deploy workflow, on every run
BACKEND_IMAGE=ghcr.io/<owner>/<repo>-backend:<git-sha>
```

and runs `docker compose` with **both** files, in this order:

```bash
docker compose -f infra/app/docker-compose.yml \
  --env-file infra/app/.env --env-file infra/app/image.env \
  pull backend
# ... run --rm backend bun run prisma:deploy, then up -d backend - same --env-file pair
```

`--env-file` can be repeated; when the same key appears in more than one,
the last one wins (Compose v2.24+ - check `docker compose version` on the
VPS if this ever behaves unexpectedly on an older install). `image.env`
only ever sets `BACKEND_IMAGE`, so it overrides just that one value; every
other variable still comes from the persistent `.env`. After `up -d`, the
workflow polls `docker inspect --format '{{.State.Health.Status}}'
vibestart-backend` (the container name this compose file sets) until it
reports `healthy` or a ~60s budget runs out, printing the container's last
100 log lines and failing the job if it never does - that's the "did the
new image actually come up" check.

`make app-up`/`make app-migrate` (manual, local use) don't know about
`image.env` - they read only `infra/app/.env`, which should keep its own
`BACKEND_IMAGE` line (from `.env.example`) up to date by hand for anyone
operating the stack outside of CI.

## First deploy order

`make up` runs the full sequence in one shot (`network -> supabase -> app
-> edge`, reverse for `make down`) - but `infra/app/.env` (like
`infra/edge/.env`) must exist and be filled in first, or `docker compose
up` in `infra/app` fails loudly on the required `BACKEND_IMAGE` var. On a
fresh VPS:

1. `cp infra/app/.env.example infra/app/.env`, fill in real values (and
   `infra/edge/.env` too, if this is the very first deploy - see
   `infra/edge/README.md`).
2. `make ensure-network && make supabase-up`.
3. `make app-migrate` - applies the schema before the app ever starts
   serving traffic against it. Deliberately **not** part of the `make up`
   chain (a schema migration is never something a routine restart should
   run silently) - always run it by hand, once per deploy that includes a
   new migration.
4. `make up` (or just `make app-up && make edge-up` if supabase is already
   running) - brings up `app` and `edge`. Routine restarts afterwards are
   just `make up` / `make down`, which cover all three stacks together.

## Local testing loop

Build the image locally instead of pulling from GHCR, to test a change to
`backend/` end-to-end before pushing:

```bash
docker build -f backend/Dockerfile -t vibestart-backend:local .   # from the repo root

make supabase-up
cp infra/app/.env.example infra/app/.env   # then edit: BACKEND_IMAGE=vibestart-backend:local,
                                            # POSTGRES_PASSWORD from infra/supabase/.env,
                                            # SUPABASE_JWT_SECRET from infra/supabase/.env
make ensure-network                        # `edge` network, needed even without infra/edge running
make app-migrate
make app-up
docker inspect --format '{{json .State.Health}}' vibestart-backend
docker run --rm --network edge curlimages/curl -sf http://backend:3000/health/ready

make app-down
make supabase-down
rm infra/app/.env
```

`SUPABASE_JWT_ISSUER` can be left as the placeholder for this local loop
(no real GoTrue tokens are being verified) - it only matters once real
traffic through `infra/edge`/a real Supabase project is involved.

## Rollback

Previous image tags stay in GHCR (`docker/build-push-action` tags every
build with the git sha, `latest`, and the pushed tag - see
`.github/workflows/deploy.yml`). Roll back by pointing `BACKEND_IMAGE` at an
older tag and restarting just that service:

```bash
# infra/app/.env: BACKEND_IMAGE=ghcr.io/<owner>/<repo>-backend:<previous-sha-or-tag>
docker compose -f infra/app/docker-compose.yml pull backend
docker compose -f infra/app/docker-compose.yml up -d backend
```

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
