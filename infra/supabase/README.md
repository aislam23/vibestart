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
commit `9e225a279b33e4e6e1452e573a40a6a25aa2cb2f`, fetched 2026-08-08).
`infra/supabase/volumes/` mirrors the official `docker/volumes/` layout
that the compose file mounts (Kong's declarative config + entrypoint,
Postgres init scripts).

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
- **Public `/pg/` (postgres-meta) route in `volumes/api/kong.yml`** -
  Studio reaches `meta` internally via `STUDIO_PG_META_URL`
  (`http://meta:8080`); the public route added surface with no
  functionality behind it. Re-add it from upstream `kong.yml` (service
  `meta`, route `/pg/`) behind basic-auth if external SQL tooling is ever
  needed.

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
- **Studio**: not published by default, and never reachable directly
  through the edge proxy - only `kong` joins the `edge` network (see the
  commented `networks:` blocks in `docker-compose.yml`). In production,
  Studio must be reached only through Kong's `dashboard` route
  (`volumes/api/kong.yml`), which enforces basic-auth from
  `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`. For local access, uncomment
  the `ports:` block on the `studio` service in `docker-compose.yml`
  (`127.0.0.1:54323:3000`), then open `http://localhost:54323` - this
  bypasses Kong's basic-auth, so only do it locally.
- **Postgres**: `127.0.0.1:54322` (default; `POSTGRES_PORT` in `.env`) -
  for `psql`, migrations, or pointing the backend directly at the database.

All published ports are bound to `127.0.0.1` - nothing here is meant to be
internet-facing on its own. TLS termination and public exposure are handled
by the Caddy edge-proxy stack (`infra/edge`, added in a later task), which
will reverse-proxy to `kong` and `studio`.

## Secret generation modes

`generate-secrets.ts` is install-only: by default it refuses to touch an
existing `.env`.

- **Default** (`bun run secrets:generate`) - dev-friendly: loopback URLs,
  auto-confirmed email signup, no SMTP required.
- **`--prod`** (`bun run secrets:generate -- --prod`) - refuses to write
  `.env` unless:
  - `SITE_URL`, `API_EXTERNAL_URL`, and `SUPABASE_PUBLIC_URL` are all
    concrete `https://` URLs (not loopback, not `http://`) - pass
    `--site-url=`, `--api-external-url=`, `--public-url=`, or pre-edit
    `.env.example`;
  - either `ENABLE_EMAIL_AUTOCONFIRM=false` with SMTP configured, or
    `DISABLE_SIGNUP=true`.

  ```bash
  bun run secrets:generate -- --prod \
    --site-url=https://app.example.com \
    --api-external-url=https://supabase.example.com/auth/v1 \
    --public-url=https://supabase.example.com
  ```

  `--api-external-url`/`--public-url` MUST be the Supabase/Kong host
  (`SUPABASE_DOMAIN` - what `infra/edge/Caddyfile` routes to `kong:8000`),
  never the backend API's own host (`API_DOMAIN`, routed to `backend:3000`)
  - GoTrue stamps `API_EXTERNAL_URL` as the `iss` claim on every token it
  issues, and `infra/app/.env`'s `SUPABASE_JWT_ISSUER` must match it
  exactly. `--prod` rejects an API_DOMAIN-shaped value here as a guard
  against this exact mix-up.
- **`--force`** - regenerates an existing `.env` (dev or prod checks apply
  the same way). Backs up the current `.env` first; see "Rotating secrets"
  below for what to do with the backup.

## Rotating secrets

`bun run secrets:generate -- --force` backs up the current `.env` to
`.env.backup.<unix-timestamp>` (mode 0600) and writes a fresh set of
secrets - but **overwriting `.env` alone does not rotate anything on a
running stack.** Postgres applies `POSTGRES_PASSWORD` (and every role
password derived from it) only when `db-data` is initialized on first
boot; a restart afterward does not push a new value into Postgres. If
`docker compose up` has already run once, the running database still has
the *old* credentials after you regenerate `.env`, and every service will
fail to connect until you follow this runbook:

1. **Back up first** - `--force` already backs up `.env`; also snapshot or
   `pg_dump` the `db-data` volume before touching passwords.
2. **Rotate `POSTGRES_PASSWORD`** on the running database. All of the
   login roles below share one password (see `volumes/db/roles.sql`):
   ```bash
   docker compose exec db psql -U postgres -c "
     ALTER USER postgres WITH PASSWORD '<new password>';
     ALTER USER supabase_admin WITH PASSWORD '<new password>';
     ALTER USER authenticator WITH PASSWORD '<new password>';
     ALTER USER supabase_auth_admin WITH PASSWORD '<new password>';
     ALTER USER supabase_storage_admin WITH PASSWORD '<new password>';
     ALTER USER pgbouncer WITH PASSWORD '<new password>';
     ALTER USER supabase_functions_admin WITH PASSWORD '<new password>';
   "
   ```
   (`pgbouncer`/`supabase_functions_admin` aren't used by this trimmed
   stack's services but still exist in the database - rotate them too for
   consistency.)
3. **Update `.env`** so `POSTGRES_PASSWORD` matches what you just set.
4. **Restart**: `docker compose up -d` (running containers already have
   the old value baked into their process environment).

**`JWT_SECRET` rotation** is simpler but more disruptive: it invalidates
every issued session token immediately (GoTrue, PostgREST, Storage, and
Realtime all verify against it). `generate-secrets.ts` always regenerates
`ANON_KEY`/`SERVICE_ROLE_KEY` together with a new `JWT_SECRET` in the same
run - never hand-edit `JWT_SECRET` without regenerating both keys, since
they're signed with it. After updating `.env`, restart the stack; every
existing client session and any hardcoded `ANON_KEY`/`SERVICE_ROLE_KEY`
(backend `.env`, frontend build) must be updated too - there's no
in-place migration for those.

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

**This is only configuration-only for a fresh install with no stored
objects yet.** Object metadata (bucket/key, size, checksum) lives in
Postgres; flipping `STORAGE_BACKEND` after objects already exist leaves
the metadata rows pointing at bytes that live in the *other* backend, so
existing files 404 until you migrate the actual bytes (download from
`storage-data` / upload to the bucket, or vice versa) to match wherever
the metadata says they are. **Recommend `s3` from day one on a VPS** -
switching later means a manual migration, not a config edit.

Before going live on `s3`, do a preflight: verify the configured
credentials can actually read and write the bucket (e.g. `aws s3 cp` a
test object up and back down, or `aws s3api head-bucket`) - a bad
key/region/endpoint otherwise only surfaces the first time a user uploads
a file.

## Upgrading

Every image tag in `docker-compose.yml` is pinned exactly (no `latest`).
Bumping a version means:

1. Diff the current [supabase/supabase `docker/docker-compose.yml`](https://github.com/supabase/supabase/blob/master/docker/docker-compose.yml)
   against this file for the service(s) you're upgrading - check for env
   var renames/additions, not just the tag.
2. Update the tag and any changed env vars here.
3. Re-run the validation below before shipping.

**Cohort rule**: all tags here were re-derived from one upstream commit
(`9e225a279b33e4e6e1452e573a40a6a25aa2cb2f`, see "What's in the stack").
Upgrades must re-derive *all* service tags from a single new upstream
snapshot together - never bump one service's tag in isolation, since
upstream only tests and ships them as a cohort.

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

docker compose down       # stop the stack, keep all data
```

## Destructive: full local reset

```bash
docker compose down -v
```

`-v` deletes the `db-data`, `db-config`, and `storage-data` volumes -
**all Postgres data, `storage-data`'s local files, and the `db-config`
pgsodium encryption key material are gone, unrecoverable.** Only use this
for a throwaway local reset (e.g. you want a truly clean re-init). Never
run this against a stack holding real data.
