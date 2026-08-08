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
| Backup | `infra/backup` | none | coming (T4) |

`backend` (Bun+Hono API, T5), `webapp` (React CSR build, T6), and `website`
(Astro build, T7) aren't separate compose stacks - `backend` runs as its
own compose service that joins the `edge` network, and `webapp`/`website`
are static builds Caddy serves directly from bind mounts.

## Network topology

`infra/edge` owns a Docker network named `edge` (fixed name, not
project-prefixed, so other compose projects can attach to it as
`external: true`). It is the **only** network any of this reaches the
internet through - every other service either binds to `127.0.0.1` or
stays on its stack's private compose network and is reached from Caddy by
joining `edge`.

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
                  (bind mount) (bind mount)  (edge network, (edge network,
                                               T5)            infra/supabase)
                                                                   |
                                                     +-------------------------+
                                                     |     infra/supabase      |
                                                     | db, auth, rest,         |
                                                     | realtime, storage,      |
                                                     | meta, studio, kong      |
                                                     | (private `supabase`     |
                                                     |  network; only kong     |
                                                     |  joins `edge`)          |
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
   bringing the edge stack up (Caddy requests ACME certs on first
   request per host).
3. **Firewall**: only 22 (SSH), 80, and 443 open to the internet - every
   other port (Postgres 54322, Kong's `KONG_HTTP_PORT` 54321, Caddy's
   admin API on 2019) stays bound to `127.0.0.1` or container-internal and
   must never be opened externally. Use whatever the VPS provider or OS
   ships (`ufw`, `nftables`, a cloud security-group) - not prescribed here.
4. **Secrets**: `make secrets` (writes `infra/supabase/.env`); copy
   `infra/edge/.env.example` to `infra/edge/.env` and fill in real domains.
5. **First run**: `make edge-up` once (creates the `edge` network), then
   uncomment `infra/supabase`'s `kong` network block per
   `infra/edge/README.md`, then `make up` for every run after that.

## Staging

Pattern only - not implemented. Run a second, independently-named compose
project per stack (e.g. `infra/edge` with `COMPOSE_PROJECT_NAME=edge-staging`
or a second `.env`/compose invocation) fronting `staging.`-prefixed
subdomains (`staging.app.example.com`, etc.), pointed at either a second
VPS or a second Supabase project on the same VPS under a different
project name. Left for whoever sets up staging to design against real
constraints (isolated vs. shared Supabase, cost, data separation) rather
than dictated here.
