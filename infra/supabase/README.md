# infra/supabase

Self-hosted [Supabase](https://supabase.com) stack for vibestart, run with Docker
Compose. Trimmed to what vibestart actually uses; everything is pinned to
exact image versions from the official reference so upgrades are a
deliberate, documented act rather than something that happens on `docker
compose pull`.

## What's in the stack

| Service | Image | Role |
|---|---|---|
| `db` | `supabase/postgres:17.6.1.136` | Postgres, with Supabase's roles/extensions baked in |
| `auth` | `supabase/gotrue:v2.189.0` | Email/password auth, issues Supabase JWTs |
| `rest` | `postgrest/postgrest:v14.12` | Auto-generated REST API over Postgres |
| `realtime` | `supabase/realtime:v2.102.3` | Postgres change streams over WebSocket |
| `storage` | `supabase/storage-api:v1.60.4` | File storage API (local disk or S3-backed) |
| `imgproxy` | `darthsim/imgproxy:v3.30.1` | On-the-fly image transforms for Storage |
| `meta` | `supabase/postgres-meta:v0.96.6` | Postgres introspection API, used by Studio |
| `kong` | `kong/kong:3.9.3` | API gateway - single entry point, routes `/auth`, `/rest`, `/realtime`, `/storage` |
| `studio` | `supabase/studio:2026.08.03-sha-022b374` | Web dashboard |

Reference source: `docker/docker-compose.yml` and `docker/.env.example` from
[supabase/supabase](https://github.com/supabase/supabase) (`master` branch,
fetched 2026-08-08). `infra/supabase/volumes/` mirrors the official
`docker/volumes/` layout that the compose file mounts (Kong's declarative
config + entrypoint, Postgres init scripts).

## What was removed, and why

- **`analytics` (Logflare) / `vector`** - not present in the fetched
  reference file at all (upstream already dropped it from the default
  stack); nothing to strip.
- **`functions` (edge-runtime)** - vibestart's Hono backend is the app
  server; we don't need a second one embedded in Supabase. Removed the
  service, its `JWT_SECRET`/`SUPABASE_*`/`FUNCTIONS_VERIFY_JWT` env wiring,
  and the `functions-v1` route in `volumes/api/kong.yml`.
- **`supavisor` (connection pooler)** - our backend holds its own Postgres
  connection pool; clients don't connect to `db` at any real scale that
  needs a separate pooler. Removed the service, all `POOLER_*` env vars,
  and `volumes/db/pooler.sql` (the `_supavisor` schema it created was only
  ever used by supavisor).

Everything else matches the official wiring: env var names, healthchecks,
dependency ordering, and the Postgres init scripts (`webhooks.sql` -
database webhooks/`pg_net`, unrelated to the removed edge-functions runtime
- `roles.sql`, `jwt.sql`, `realtime.sql`, plus `_supabase.sql`/`logs.sql`
kept for parity even though nothing currently reads the `_analytics`
schema they create).

## Local setup

```bash
bun run secrets:generate      # from repo root - writes infra/supabase/.env
cd infra/supabase
docker compose up -d
```

Wait for everything to report healthy (`docker compose ps`), then:

- **Kong API gateway**: `http://localhost:54321` (default; `KONG_HTTP_PORT`
  in `.env`). All client traffic (`supabase-js`, the backend) goes through
  here - `/auth/v1`, `/rest/v1`, `/realtime/v1`, `/storage/v1`.
- **Studio**: not published by default (it's meant to be reached through
  the Caddy edge proxy added in a later task). For local access, uncomment
  the `ports:` block on the `studio` service in `docker-compose.yml`
  (`127.0.0.1:54323:3000`), then open `http://localhost:54323`.
- **Postgres**: `127.0.0.1:54322` (default; `POSTGRES_PORT` in `.env`) -
  for `psql`, migrations, or pointing the backend directly at the database.

All published ports are bound to `127.0.0.1` - nothing here is meant to be
internet-facing on its own. TLS termination and public exposure are handled
by the Caddy edge-proxy stack (`infra/edge`, added in a later task), which
will reverse-proxy to `kong` and `studio`.

To regenerate secrets (e.g. rotating `JWT_SECRET`, which invalidates every
existing session and API key): `bun run secrets:generate -- --force`.

## Storage: local disk vs S3

Controlled by `STORAGE_BACKEND` in `.env`:

- **`file`** (default) - Storage writes into the `storage-data` Docker
  volume. No credentials needed; this is what local dev uses out of the
  box.
- **`s3`** (production) - Storage writes to an external S3-compatible
  bucket instead of local disk. Set in `.env`:
  - `STORAGE_BACKEND=s3`
  - `GLOBAL_S3_BUCKET`, `GLOBAL_S3_ENDPOINT`, `REGION`
  - `GLOBAL_S3_FORCE_PATH_STYLE=true` (needed by most non-AWS S3-compatible
    providers - R2, Backblaze B2, MinIO, etc.)
  - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`

Both sets of env vars are always present in the compose file; the unused
one is simply ignored by `storage-api` depending on `STORAGE_BACKEND`, so
switching modes never requires touching `docker-compose.yml` - only `.env`.

## Upgrading

Every image tag in `docker-compose.yml` is pinned exactly (no `latest`).
Bumping a version means:

1. Diff the current [supabase/supabase `docker/docker-compose.yml`](https://github.com/supabase/supabase/blob/master/docker/docker-compose.yml)
   against this file for the service(s) you're upgrading - check for env
   var renames/additions, not just the tag.
2. Update the tag and any changed env vars here.
3. Re-run the validation below before shipping.

## Validation

```bash
cd infra/supabase
docker compose --env-file .env config   # should exit 0

docker compose up -d
# wait for `docker compose ps` to show all services healthy, then:
curl -i http://localhost:54321/                                          # Kong is up (401/404 expected without a key)
curl http://localhost:54321/auth/v1/health -H "apikey: $ANON_KEY"        # GoTrue: {"version":...}
curl -i http://localhost:54321/rest/v1/some_table -H "apikey: $ANON_KEY" # PostgREST: 200/404 (not the exact "/rest/v1/" root - that's an admin-only route)
curl -i http://localhost:54321/storage/v1/status -H "apikey: $ANON_KEY"  # Storage: 200
docker compose exec db pg_isready -U postgres -h localhost               # accepting connections

docker compose down -v   # tear down, drop volumes
```
