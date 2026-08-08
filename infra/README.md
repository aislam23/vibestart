# infra

Everything needed to run vibestart on a single VPS with Docker Compose:
one compose project per concern, wired together over a shared Docker
network. Operate all of it through the root `Makefile` (`make help`)
rather than calling `docker compose` in each directory by hand.

## The stacks

| Stack | Directory | Ports published to the internet | Status |
|---|---|---|---|
| Edge proxy | `infra/edge` | 80, 443, 443/udp | done (T3) |
| Supabase | `infra/supabase` | none - `127.0.0.1` only | done (T2) |
| Backup | `infra/backup` | none | done (T4) |
| App (backend) | `infra/app` | none - reached only via `edge` | done (T7) |

`webapp` (React CSR build, T6) and `website` (Astro build, T7) aren't
separate compose stacks - they're static builds Caddy serves directly from
bind mounts. `backend` (Bun+Hono API, T5) **is** a compose stack as of T7 -
`infra/app` runs the image built by `backend/Dockerfile` (pushed to GHCR by
`.github/workflows/deploy.yml`) as a plain service that joins `edge` (so
Caddy can reach it) and `supabase` (so it can reach Postgres/Kong) - see
`infra/app/README.md`.

## Network topology

The `edge` Docker network (fixed name, not project-prefixed) is
provisioned independently of any single stack - `make ensure-network` (run
automatically by `make up`/`edge-up`/`supabase-up`/`app-up`), or `docker
network create edge` directly. Every compose project that needs it
(`infra/edge`, `infra/supabase`'s `kong` service, and `infra/app`'s
`backend` service) attaches as `external: true`, so any stack can be
started or stopped in any order. It is the **only** network any of this
reaches the internet through - every other service either binds to
`127.0.0.1` or stays on its stack's private compose network and is reached
from Caddy by joining `edge`.

```
                              Internet
                                 |
                            80 / 443 / 443-udp
                                 v
                       +-------------------+
                       |   infra/edge      |
                       |   caddy (edge)    |
                       +-------------------+
                        |       |      |   \
                        |       |      |    \
                  webapp/dist website/dist  backend:3000   kong:8000
                  (bind mount) (bind mount)  (edge network,  (edge network,
                                               infra/app)      infra/supabase)
                                                    |               |
                                                    v               v
                                          +----------------+  +-------------------------+
                                          |   infra/app    |  |     infra/supabase      |
                                          |   backend      |->|  db, auth, rest,         |
                                          |   (`supabase`  |  |  realtime, storage,      |
                                          |    network)    |  |  meta, studio, kong      |
                                          +----------------+  |  (private `supabase`     |
                                                               |   network; kong also     |
                                                               |   joins `edge`)          |
                                                               +-------------------------+
```

`db`, `auth`, `rest`, `realtime`, `storage`, `meta`, and `studio` never
join `edge` and are unreachable from outside the VPS. Studio is reached
only through Kong's `dashboard` route (basic-auth enforced by Kong), never
proxied to directly - see `infra/supabase/README.md`.

`infra/supabase`'s `kong` service and the `edge` network declaration ship
**commented out** by default; activating the connection is a deliberate,
documented step (`infra/edge/README.md`, "First run on a VPS") rather than
something that happens automatically.

`infra/app` and `infra/backup` are the two stacks that join the private
`supabase` network directly (not just `edge`), so `backend` can reach
`db`/`kong` by service name and `backup` can reach `db` to run `pg_dump` -
`infra/app`'s `backend` service is also the one non-`kong` service that
joins **both** `edge` and `supabase` at once, since it needs to be reached
by Caddy *and* reach Postgres/Kong. See `infra/app/README.md` and
`infra/backup/README.md`.

## VPS bootstrap checklist

Reference pointers, not a script - the exact commands depend on the VPS's
OS and provider.

1. **Docker + Compose**: install Docker Engine and the Compose plugin
   (`docker compose version` should report v2+). See
   [docs.docker.com/engine/install](https://docs.docker.com/engine/install/)
   for your distro; most current VPS images support the official
   `get.docker.com` convenience script.
2. **DNS**: A (and AAAA, if the VPS has IPv6) records for every domain in
   `infra/edge/.env` (`APP_DOMAIN`, `SITE_DOMAIN`, `API_DOMAIN`,
   `SUPABASE_DOMAIN`) pointing at the VPS's public IP, set up *before*
   bringing the edge stack up - Caddy requests ACME certs for every host
   as soon as it loads its config, and a host with unresolved DNS just
   stays uncertified until DNS catches up (see `infra/edge/README.md`,
   "How TLS/ACME works").
3. **Firewall**: only 22 (SSH), 80, and 443 open to the internet - every
   other port (Postgres 54322, Kong's `KONG_HTTP_PORT` 54321, Caddy's
   admin API on 2019) stays bound to `127.0.0.1` or container-internal and
   must never be opened externally. Use whatever the VPS provider or OS
   ships (`ufw`, `nftables`, a cloud security-group) - not prescribed here.
   Note that Docker-published ports (any service's `ports:` entry) insert
   their own rules ahead of most firewall chains and bypass `ufw`/`nftables`
   filtering by default - enforce at the provider firewall (cloud
   security-group) and/or Docker's `DOCKER-USER` iptables chain, not `ufw`
   alone. The current stacks bind every internal service to `127.0.0.1`,
   so nothing is exposed by default; treat adding a `ports:` entry to any
   future service as a firewall decision, not just a compose edit.
4. **Secrets**: `make secrets-prod` (writes `infra/supabase/.env`; pass
   `ARGS="--site-url=... --api-external-url=... --public-url=..."` for the
   production URLs - see the root `Makefile`); copy
   `infra/edge/.env.example` to `infra/edge/.env` and fill in real domains;
   copy `infra/app/.env.example` to `infra/app/.env` and fill in real
   values (`BACKEND_IMAGE` needs a GHCR reference already pushed by
   `.github/workflows/deploy.yml` - see `infra/app/README.md`).
5. **Static build directories**: create `webapp/dist` and `website/dist`
   on the VPS (owned by the deploy user) before bringing the edge stack up
   - they're bind-mounted read-only with `create_host_path: false`, so
   Compose refuses to create them for you.
6. **Docker log limits**: set log rotation daemon-wide in
   `/etc/docker/daemon.json` so the Supabase stack's many services don't
   fill the disk with unbounded logs (the edge stack's `caddy` service
   already sets its own limits in `docker-compose.yml`):
   ```json
   {
     "log-driver": "json-file",
     "log-opts": { "max-size": "10m", "max-file": "5" }
   }
   ```
   then `systemctl restart docker` to apply it.
7. **First run**: `make ensure-network && make supabase-up`, then uncomment
   `infra/supabase`'s `kong` network block per `infra/edge/README.md` so
   Caddy (and `backend`) can reach it; `make app-migrate` (applies
   `backend/prisma/migrations` before the app serves any traffic - see
   `infra/app/README.md`); then `make up` for the rest (`app`, then
   `edge` - `supabase-up` is a no-op at this point since it's already
   running). The `edge` network is provisioned independently of any one
   stack, so `infra/supabase`, `infra/app`, and `infra/edge` can each be
   started or stopped in any order after this first-run sequence.

## Staging

Pattern only - not implemented. Run a second, independently-named compose
project per stack (e.g. `infra/edge` with `COMPOSE_PROJECT_NAME=edge-staging`
or a second `.env`/compose invocation) fronting `staging.`-prefixed
subdomains (`staging.app.example.com`, etc.), pointed at either a second
VPS or a second Supabase project on the same VPS under a different
project name. Left for whoever sets up staging to design against real
constraints (isolated vs. shared Supabase, cost, data separation) rather
than dictated here.
