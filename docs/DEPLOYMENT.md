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

## 4. Secrets

```bash
# infra/supabase/.env — production mode refuses to write unless SITE_URL/API_EXTERNAL_URL/
# SUPABASE_PUBLIC_URL are all concrete https:// URLs, and either autoconfirm is off with SMTP
# configured, or signup is disabled.
make secrets-prod ARGS="--site-url=https://app.example.com \
  --api-external-url=https://api.example.com/auth/v1 \
  --public-url=https://api.example.com"

cp infra/edge/.env.example infra/edge/.env       # fill in real domains + ACME_EMAIL
cp infra/app/.env.example infra/app/.env         # fill in real values — see infra/app/README.md
```

`infra/app/.env` needs `BACKEND_IMAGE` pointing at an already-published GHCR reference — the first
one only exists after step 7 (CI has pushed at least once), so this file's `BACKEND_IMAGE` line
stays a placeholder until then.

`infra/backup/.env` is a separate first-run setup with its own S3 bucket and a restic password —
see `infra/backup/README.md`, "First-run setup", and `docs/BACKUPS.md`.

## 5. Static build directories

Create `webapp/dist` and `website/dist` on the VPS, owned by the deploy user, before bringing the
edge stack up — they're bind-mounted read-only with `create_host_path: false`, so Compose refuses
to create them automatically.

## 6. Bring the stacks up, in order

```bash
make ensure-network && make supabase-up
```

Then uncomment `infra/supabase/docker-compose.yml`'s `kong` service `networks:` block and the
`edge:` network declaration at the bottom of the file (search for `T3` in that file) — this repo
does not wire Supabase to the edge network automatically; it's a deliberate step. See
`infra/edge/README.md`, "First run on a VPS", step 3.

```bash
make app-migrate     # applies backend/prisma/migrations before the app ever serves traffic
make up               # brings up app, then edge (supabase-up is now a no-op — already running)
```

After this first-run sequence, `infra/supabase`, `infra/app`, and `infra/edge` can each be started
or stopped independently, in any order — the `edge` network is provisioned separately from any one
stack.

Verify: `curl -I https://your-domain` once DNS has propagated, and `make status` for container
health across every stack.

## 7. CI/CD: GHCR + GitHub Actions

`.github/workflows/deploy.yml` runs on every `v*` tag push, or a manual `workflow_dispatch`:

1. **`build-push`** — builds `backend/Dockerfile` (repo root as Docker context, since the image
   copies `packages/contracts` alongside `backend/`), pushes to
   `ghcr.io/<owner>/<repo>-backend`, tagged with the commit SHA always, plus the git tag and
   `latest` when triggered by a real version tag.
2. **`deploy`** (environment `production`, needs `build-push`) — builds `webapp`/`website` static
   bundles in CI, `rsync`s both `dist/` directories to the VPS, then over the same SSH connection:
   writes only the fresh `BACKEND_IMAGE` tag to `infra/app/image.env` (atomic write, never touches
   the real `infra/app/.env`), pulls the new image, runs `prisma migrate deploy`, rolls the
   `backend` service, and polls its Docker healthcheck (~60s budget) before declaring success.

Required secrets and variables (SSH key, known-hosts pin, deploy path, Vite/Astro build-time public
vars) are all listed in `.github/workflows/README.md`, including exactly what the least-privilege
deploy user needs and nothing more. Provision them under the `production` GitHub Environment, not
repository-wide, so an arbitrary branch can't read them.

`infra/app/.env` (the real secrets file) is **never** written by CI — it's created once, by hand,
in step 4 above, and stays that way.

## Rollback

Previous image tags stay in GHCR (every build is tagged with the git SHA). Point `BACKEND_IMAGE` in
`infra/app/.env` at an older tag and restart just that service:

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
