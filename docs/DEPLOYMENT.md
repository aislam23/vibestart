# Deployment

The full VPS deploy runbook. This is the one and only deployment path this template supports: a
single VPS running Docker Compose, with a self-hosted Supabase stack. There is no
DigitalOcean/Yandex/managed-cloud alternative — see `AGENTS.md`, "Hosting reality".

This document is the sequence; the compose files and every flag are documented in each stack's own
README (`infra/supabase/README.md`, `infra/edge/README.md`, `infra/app/README.md`,
`infra/backup/README.md`) and in `infra/README.md` (network topology). Don't duplicate those files
here — follow the links.

## 1. Provision the VPS

- Docker Engine + the Compose v2 plugin (`docker compose version` reports v2+).
- Docker log rotation set daemon-wide (`/etc/docker/daemon.json`, `max-size: 10m`, `max-file: 5`),
  then `systemctl restart docker` — the Supabase stack's many services can otherwise fill the disk
  with unbounded logs. See `infra/README.md`'s bootstrap checklist for the exact JSON.
- A deploy user in the `docker` group (not `root`, not passwordless `sudo`) — see
  `.github/workflows/README.md`, "Least-privilege deploy user", for exactly what it needs.

## 2. DNS

Create A (and AAAA, if the VPS has IPv6) records for every domain **before** bringing the edge
stack up:

- `APP_DOMAIN` (webapp)
- `SITE_DOMAIN` (website)
- `API_DOMAIN` (backend)
- `SUPABASE_DOMAIN` (Kong/Studio)

Caddy requests an ACME certificate for every configured domain as soon as it loads its config — a
domain with unresolved DNS just stays uncertified until DNS catches up; it doesn't block the others
or crash the stack. See `infra/edge/README.md`, "How TLS/ACME works".

## 3. Firewall

Only 22 (SSH), 80, and 443 open to the internet. Everything else (Postgres 54322, Kong's HTTP port
54321, Caddy's admin API 2019) stays bound to `127.0.0.1` or container-internal. **Docker-published
ports bypass `ufw`/`nftables` by default** — enforce at the provider firewall (cloud security
group) and/or Docker's `DOCKER-USER` iptables chain, not `ufw` alone. Every current service already
binds to `127.0.0.1`; treat adding a `ports:` entry to any future service as a firewall decision,
not just a compose edit.

## 4. Network + Supabase

```bash
make ensure-network && make supabase-up
```

Then uncomment `infra/supabase/docker-compose.yml`'s `kong` service `networks:` block and the
`edge:` network declaration at the bottom of the file (search for `T3` in that file) — this repo
does not wire Supabase to the edge network automatically; it's a deliberate step. See
`infra/edge/README.md`, "First run on a VPS", step 3.

## 5. Secrets

```bash
# infra/supabase/.env — production mode refuses to write unless SITE_URL/API_EXTERNAL_URL/
# SUPABASE_PUBLIC_URL are all concrete https:// URLs, and either autoconfirm is off with SMTP
# configured, or signup is disabled. API_EXTERNAL_URL/SUPABASE_PUBLIC_URL MUST be the Supabase/Kong
# host (SUPABASE_DOMAIN, what infra/edge's Caddyfile routes to `kong:8000`) — NOT the backend API's
# own host (API_DOMAIN, routed to `backend:3000`). GoTrue stamps API_EXTERNAL_URL as the `iss` claim
# on every token it issues; infra/app/.env's SUPABASE_JWT_ISSUER below must match it exactly, or
# every request gets rejected. `generate-secrets.ts --prod` rejects an API_DOMAIN-shaped value here
# as a guard against this exact copy-paste mistake — see infra/supabase/generate-secrets.ts.
make secrets-prod ARGS="--site-url=https://app.example.com \
  --api-external-url=https://supabase.example.com/auth/v1 \
  --public-url=https://supabase.example.com"

cp infra/edge/.env.example infra/edge/.env       # fill in real domains + ACME_EMAIL
cp infra/app/.env.example infra/app/.env         # fill in real values — see infra/app/README.md
chmod 600 infra/app/.env infra/edge/.env         # these hold real credentials
```

`infra/app/.env`'s `DATABASE_URL` defaults to the least-privileged `backend_runtime` role, and
`MIGRATE_DATABASE_URL` to the `supabase_admin` superuser — see infra/app/.env.example's comments.
`backend_runtime` doesn't exist as a *login* role yet at this point (it's created `NOLOGIN` by a
migration, see step 7) — `backend` cannot actually connect until step 8 activates it. `BACKEND_IMAGE`
needs a GHCR reference — the first one only exists after step 6 (an image has actually been pushed),
so this line stays a placeholder until then.

`infra/backup/.env` is a separate first-run setup with its own S3 bucket and a restic password —
see `infra/backup/README.md`, "First-run setup", and `docs/BACKUPS.md`.

## 6. Get the backend image into GHCR

The first deploy has a real ordering constraint: `infra/app`'s compose stack cannot start without a
published `BACKEND_IMAGE`, so the image must exist in GHCR *before* `make app-up` (or CI's `deploy`
job) ever runs. Two ways to get there:

- **Recommended — let CI do everything below in one shot.** Once this repository is pushed to
  GitHub with a passing `ci.yml` run on the commit you want live, push a `v*` tag (or run
  `deploy.yml` via `workflow_dispatch` with that commit's SHA). `.github/workflows/deploy.yml`'s
  `deploy` job builds the image, pushes it, syncs a versioned release bundle, runs the migration,
  activates nothing on its own (see step 8 — `backend_runtime` activation is still a one-time manual
  step, done once, before the *first* such run reaches a healthy backend), and rolls `backend` out —
  see `.github/workflows/README.md`, "Deploy target validation" and "Release layout on the VPS". If
  you go this route, do steps 7–9 below *before* triggering the workflow, then skip straight to
  verification.
- **Manual / no CI yet** — build and push by hand:
  ```bash
  docker build -f backend/Dockerfile -t ghcr.io/<owner>/<repo>-backend:bootstrap .   # from the repo root
  echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
  docker push ghcr.io/<owner>/<repo>-backend:bootstrap
  ```
  then set `infra/app/.env`'s `BACKEND_IMAGE` to that reference, and on the VPS itself:
  `echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin` (the VPS
  never assumes GHCR packages are public — see `.github/workflows/README.md`'s `GHCR_PULL_TOKEN`
  secret).

## 7. Release directories

Create `$DEPLOY_PATH/releases` on the VPS, owned by the deploy user, before bringing the edge stack
up — `infra/edge/docker-compose.yml` bind-mounts it read-only with `create_host_path: false`, so
Compose refuses to create it automatically. See `.github/workflows/README.md`, "Release layout on
the VPS", for what CI writes under it (`releases/<sha>/`, the `current` symlink) — this directory is
shared between CI's automated deploys and any manual `make app-*` runs from a plain checkout.

## 8. Migrate, then activate `backend_runtime`, then bring the app up

```bash
make app-migrate     # applies backend/prisma/migrations, including the migration that creates
                      # backend_runtime (still NOLOGIN at this point) — before the app ever serves
                      # traffic against the schema
```

`infra/app/.env`'s `DATABASE_URL` already points at `backend_runtime` (not `postgres`) — activate
it as an actual login role, once, as a superuser, before `backend` can connect at all:

```bash
docker compose -f infra/supabase/docker-compose.yml exec db psql -U supabase_admin -c \
  "ALTER ROLE backend_runtime LOGIN PASSWORD '<generated>';"
```

Generate `<generated>` yourself (`openssl rand -base64 32`) and make sure `infra/app/.env`'s
`DATABASE_URL` password matches it. See `backend/README.md`, "Runtime DB role", for the full
reasoning. Then:

```bash
make up               # brings up app, then edge (supabase-up is now a no-op — already running)
```

After this first-run sequence, `infra/supabase`, `infra/app`, and `infra/edge` can each be started
or stopped independently, in any order — the `edge`/`app_edge` networks are provisioned separately
from any one stack.

## 9. Verify

`curl -I https://your-domain` once DNS has propagated, and `make status` for container health
across every stack.

## 10. CI/CD: GHCR + GitHub Actions

`.github/workflows/deploy.yml` runs on every `v*` tag push, or a manual `workflow_dispatch` with an
explicit, pre-validated commit SHA (see `.github/workflows/README.md`, "Deploy target validation" —
the target must be a strict-SemVer tag or 40-char SHA, an ancestor of `main`, and have a successful
`ci.yml` run recorded against it before anything is built):

1. **`validate`** — resolves and checks the deploy target (above); nothing downstream runs until it
   passes.
2. **`build-push`** — builds `backend/Dockerfile` (repo root as Docker context, since the image
   copies `packages/contracts` alongside `backend/`) at the validated commit, pushes to
   `ghcr.io/<owner>/<repo>-backend` tagged with the commit SHA only (with SLSA provenance + an SBOM
   attached), and records the pushed digest.
3. **`deploy`** (environment `production`) — builds `webapp`/`website` static bundles in CI,
   promotes `latest`/the version tag to that digest (only now, behind the environment gate),
   `rsync`s a versioned release bundle (this commit's `infra/`, `Makefile`, both `dist/`
   directories) to `$DEPLOY_PATH/releases/<sha>` on the VPS, then over SSH: logs in to GHCR with
   `GHCR_PULL_TOKEN`, pulls the backend image **by digest**, runs the migration as a one-shot
   service, rolls `backend`, polls its Docker healthcheck, and — only once healthy — atomically
   flips `$DEPLOY_PATH/current` to the new release. Any failure before that point restores the
   previous image and fails the job loudly - `current` itself is only ever touched after a healthy
   rollout, so a failed deploy never needs to un-flip it.

Required secrets and variables (SSH key, known-hosts pin, GHCR pull token, deploy path, Vite/Astro
build-time public vars) are all listed in `.github/workflows/README.md`, including exactly what the
least-privilege deploy user needs and nothing more. Provision them under the `production` GitHub
Environment, not repository-wide, so an arbitrary branch can't read them.

`infra/app/.env` (the real secrets file) is **never** written by CI — it's created once, by hand,
in step 5 above, and stays that way.

## Rollback

Previous image digests stay in GHCR (every build is content-addressed and every deploy's
`image.env` records exactly which digest is live). Prefer re-running `deploy.yml` via
`workflow_dispatch` against an older, already-validated commit SHA — it goes through the same
health-gated, auto-rollback-on-failure flow as a forward deploy. For a manual rollback the workflow
can't reach, point `BACKEND_IMAGE` in `infra/app/.env` at a known digest and restart just that
service:

```bash
docker compose -f infra/app/docker-compose.yml pull backend
docker compose -f infra/app/docker-compose.yml up -d backend
```

Rolling back a schema migration is a separate, manual decision — `prisma migrate deploy` has no
built-in "down"; write a compensating migration if one is needed. Full detail:
`infra/app/README.md`, "Rollback".

## Routine operations

- `make up` / `make down` — start/stop everything, correct order both ways.
- `make status` — container health + Docker volume disk usage across every stack.
- `make app-migrate` — run after every deploy that includes a new Prisma migration (not part of the
  `make up` chain on purpose — a schema migration should never run silently on a routine restart).
- `make backup` — one-shot backup on demand; the scheduled service is `make backup-up`.

## Staging

Not implemented — pattern only. A second, independently-named Compose project per stack (e.g.
`COMPOSE_PROJECT_NAME=edge-staging`) fronting `staging.`-prefixed subdomains, on either a second VPS
or a second Supabase project on the same VPS. See `infra/README.md`, "Staging", and
`infra/edge/README.md`, "Staging", for the constraints to design against.

## See also

- `infra/README.md` — network topology, the VPS bootstrap checklist this document expands on.
- `infra/supabase/README.md`, `infra/edge/README.md`, `infra/app/README.md`,
  `infra/backup/README.md` — per-stack detail, secret rotation, upgrades, destructive operations.
- `.github/workflows/README.md` — every CI/deploy secret and variable, and the least-privilege
  deploy user's exact permissions.
- `docs/BACKUPS.md`, `docs/SUPABASE.md` — backup/restore and the Supabase stack in depth.
