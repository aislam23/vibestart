# Supabase

What's in vibestart's self-hosted Supabase stack, what was removed from upstream and why, how
Studio is reached, the storage backend switch, the upgrade rule, and the facts (port, JWT/keys)
other docs point back to here for. Source of truth for setup and secret rotation:
`infra/supabase/README.md` — this document is the cross-cutting summary.

## What's in the trimmed stack

| Service | Image | Role |
| --- | --- | --- |
| `db` | `supabase/postgres:17.6.1.136` | Postgres, with Supabase's roles/extensions baked in |
| `auth` | `supabase/gotrue` | Email/password auth, issues Supabase JWTs |
| `rest` | `postgrest/postgrest` | Auto-generated REST API over Postgres |
| `realtime` | `supabase/realtime` | Postgres change streams over WebSocket |
| `storage` | `supabase/storage-api` | File storage API (local disk or S3-backed) |
| `imgproxy` | `darthsim/imgproxy` | On-the-fly image transforms for Storage |
| `meta` | `supabase/postgres-meta` | Postgres introspection API, used by Studio |
| `kong` | `kong/kong` | API gateway — the single entry point, routes `/auth`, `/rest`, `/realtime`, `/storage` |
| `studio` | `supabase/studio` | Web dashboard |

Every image tag is pinned exactly (no `latest`) — see `infra/supabase/docker-compose.yml` for the
current versions and `infra/supabase/README.md` for the exact upstream commit they were re-derived
from.

## What was removed, and why

- **`analytics` (Logflare) / `vector`** — not present in the upstream reference file used as the
  source at all; nothing to strip.
- **`functions` (edge-runtime)** — vibestart's own Hono backend is the application server. Running
  a second one embedded inside Supabase would be redundant, so the service, its env wiring, and the
  `functions-v1` Kong route were removed.
- **`supavisor` (connection pooler)** — the backend holds its own Postgres connection pool;
  nothing here connects to `db` at a scale that needs a separate pooler. Removed with its env vars
  and the init SQL that created its schema.
- **Public `/pg/` (postgres-meta) Kong route** — Studio reaches `meta` internally
  (`STUDIO_PG_META_URL`); the public route added surface with no functionality behind it for this
  template. Re-addable behind basic-auth from upstream `kong.yml` if external SQL tooling is ever
  needed.

Everything else — env var names, healthchecks, dependency ordering, Postgres init scripts — matches
the official self-hosting reference. Full detail and the exact upstream commit hash:
`infra/supabase/README.md`, "What's in the stack" / "What was removed, and why".

## Ports and access

- **Kong (all client traffic)**: `http://localhost:54321` locally (`KONG_HTTP_PORT`). Every
  `supabase-js`/backend call goes through here — `/auth/v1`, `/rest/v1`, `/realtime/v1`,
  `/storage/v1`.
- **Postgres**: `127.0.0.1:54322` locally, and **`db:54322`** on the internal Docker network — not
  the Postgres default of 5432. This is the trimmed stack keeping the official supabase image's
  `PGPORT` convention; `infra/supabase/docker-compose.yml`'s own healthcheck relies on `PGPORT`
  rather than passing `-p` explicitly, confirming this is intentional, not a leftover. The one
  exception is `backend/docker-compose.test.yml`'s throwaway `db_test`, which deliberately pins the
  standard 5432 to stay unambiguous from the real dev/prod database.
- **Studio**: not published by default and never reachable directly through the edge proxy. In
  production it's reached **only** through Kong's `dashboard` route
  (`infra/supabase/volumes/api/kong.yml`), which enforces basic-auth
  (`DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`). For local access only, uncomment the `studio`
  service's `ports:` block in `docker-compose.yml` (`127.0.0.1:54323:3000`) — this bypasses Kong's
  basic-auth, so only do it locally.

All published ports bind to `127.0.0.1`; nothing in this stack is meant to be internet-facing on
its own. TLS and public exposure are Caddy's job (`infra/edge`) — see `docs/DEPLOYMENT.md`.

## JWTs and keys

One shared secret, `JWT_SECRET`, signs and verifies every Supabase JWT — GoTrue, PostgREST,
Realtime, and Storage all check against it. `ANON_KEY` and `SERVICE_ROLE_KEY` are themselves JWTs
*signed with* that secret (`{"role":"anon"|"service_role","iss":"supabase"}`), not separate secrets
— `ANON_KEY` is safe to expose to a browser (row-level-security-scoped), `SERVICE_ROLE_KEY` never
is. The backend independently verifies the *user*-issued access tokens GoTrue hands out at login
(`SUPABASE_JWT_SECRET`, bound to `SUPABASE_JWT_ISSUER` via the `iss` claim) — see
`docs/ARCHITECTURE.md`, "Request flow", for how that fits together. Rotating `JWT_SECRET`
invalidates every issued session immediately and needs `ANON_KEY`/`SERVICE_ROLE_KEY` regenerated in
the same run — see `infra/supabase/README.md`, "Rotating secrets", before ever hand-editing it.

## Storage: local disk vs. S3

`STORAGE_BACKEND` in `infra/supabase/.env`:

- **`file`** (default) — writes into the `storage-data` Docker volume. No credentials needed; this
  is local dev out of the box.
- **`s3`** (recommended for production, from day one) — writes to an external S3-compatible
  bucket. Both sets of env vars always exist in the compose file; only `STORAGE_BACKEND` decides
  which one `storage-api` actually uses, so switching is a `.env`-only change — **but only for a
  fresh install with no stored objects yet.** Object metadata (bucket/key, size, checksum) lives in
  Postgres; flipping the backend after objects exist leaves metadata pointing at bytes in the
  *other* backend, so files 404 until the actual bytes are migrated by hand. This is exactly why
  "recommend `s3` from day one" matters — switching later is a manual migration, not a config edit.

Before going live on `s3`, do a preflight: verify the credentials can actually read and write the
bucket — a bad key/region/endpoint otherwise only surfaces the first time a real user uploads a
file.

## Upgrading

Bumping any service's version means re-deriving **every** tag in the stack from one new upstream
snapshot together — never bump a single service's tag in isolation, since upstream only tests and
ships them as a cohort. Diff the current upstream `docker/docker-compose.yml` against
`infra/supabase/docker-compose.yml` for env var renames/additions, not just tags, then re-run the
validation checklist in `infra/supabase/README.md`, "Upgrading".

## See also

- `infra/supabase/README.md` — full setup, secret generation modes (`--prod`, `--force`), secret
  rotation runbook, validation commands, the destructive full-reset command.
- `docs/ARCHITECTURE.md` — how the backend and webapp verify Supabase-issued JWTs.
- `docs/BACKUPS.md` — why `db-config` (the pgsodium key) is backed up alongside Postgres data, and
  what storage-backend choice means for backup coverage.
- `CHECKLIST.md`, section 5 — the product-facing questions to ask before building on top of
  Supabase Storage.
