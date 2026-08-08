# infra/edge

Caddy reverse-proxy stack for vibestart - the **only** stack in this repo
with ports published to the internet (80/443). It terminates TLS for every
public hostname and fans traffic out to the other stacks over an internal
Docker network. `infra/supabase` and (from T5) `backend` stay bound to
`127.0.0.1` or join this stack's network; nothing else is directly
reachable from outside the VPS.

**Production only.** Local development runs `vite`/`astro` dev servers
directly and talks to Supabase on `http://localhost:54321` - see the
`LOCAL DEV` note in `.env.example`. Don't run this stack locally.

## What's in the stack

| Service | Image | Role |
|---|---|---|
| `caddy` | `caddy:2.11.4` | TLS termination (automatic ACME certs), reverse proxy, static file serving |

## Network topology

```
                         Internet
                            |
                        80/443 (+443/udp)
                            v
                    +----------------+
                    |  caddy (edge)  |
                    +----------------+
                    /       |       \  \
                   /        |        \  \
      {$APP_DOMAIN}  {$SITE_DOMAIN}  {$API_DOMAIN}   {$SUPABASE_DOMAIN}
      root /srv/webapp  root /srv/website  |               |
      (bind mount)      (bind mount)       v               v
                                    reverse_proxy    reverse_proxy
                                    backend:3000      kong:8000
                                    (edge network,     (edge network,
                                     T5)                infra/supabase)
```

`caddy` owns the `edge` Docker network (declared with a fixed `name: edge`
in `docker-compose.yml`). `infra/supabase`'s `kong` service and (starting
T5) `backend` join `edge` as `external: true` from their own compose
projects, so Caddy can reach them by service name without either stack
needing to know about the other's internals. `db`, `auth`, `rest`,
`realtime`, `storage`, `meta`, and `studio` never join `edge` and stay
unreachable from outside their own compose network - Studio in particular
is reached **only** through Kong's `dashboard` route (basic-auth), never
proxied directly (see `infra/supabase/README.md`).

## First run on a VPS

1. **DNS**: create A (and AAAA if you have IPv6) records pointing
   `APP_DOMAIN`, `SITE_DOMAIN`, `API_DOMAIN`, and `SUPABASE_DOMAIN` at the
   VPS's public IP. Caddy requests a cert per host on first request and
   that host stays unreachable over HTTPS until its DNS resolves - order
   doesn't matter across hosts, but each one blocks independently.
2. **Env**: `cp .env.example .env` and fill in the real domains + an email
   address for ACME expiry notices. See `.env.example` for details.
3. **Activate the Supabase side of the network**: `infra/supabase/docker-compose.yml`
   ships with a commented `networks:` block on the `kong` service and a
   commented `edge:` network declaration at the bottom (search for `T3` in
   that file). Uncomment both:
   ```yaml
   # on the kong service:
   networks:
     - supabase
     - edge
   # at the bottom of the file:
   networks:
     supabase:
       name: supabase
     edge:
       external: true
       name: edge
   ```
   This repo does not do that edit for you - `infra/supabase` stays
   self-contained until you deliberately wire it to the edge.
4. **Bring both stacks up** - on a genuinely fresh VPS, run `make edge-up`
   once first (see "Network creation order" below for why), then `make up`
   from the repo root for every run after that.
5. Watch `docker compose logs -f caddy` for ACME issuance; once each host
   returns a real cert, traffic flows.

**Network creation order**: Docker only creates the `edge` network the
first time this stack's `docker compose up` runs; `infra/supabase`'s `kong`
service (once step 3's block is uncommented) only *joins* it as
`external: true` and cannot create it. `make up` (root Makefile) brings
`supabase` up before `edge`, which is the right steady-state order but
means a genuinely first-ever bootstrap needs `edge`'s network to already
exist: run `make edge-up` once (or `docker compose up -d` in this
directory) *before* the first `make up`, or before uncommenting the `kong`
block, whichever comes first on a fresh VPS. After that one-time creation,
`edge` persists across `down`/`up` in any order.

## How TLS/ACME works

Caddy's `email` global option (from `ACME_EMAIL`) registers with Let's
Encrypt; each `{$..._DOMAIN}` site block gets its own certificate issued
automatically on first HTTPS request to that host, renewed automatically
before expiry, and cached in the `caddy-data` named volume (do not delete
this volume casually - it holds the ACME account key and every issued
cert, and hitting Let's Encrypt's rate limits while re-issuing is easy to
trigger by accident). `caddy-config` holds Caddy's runtime-adapted config
state. Both volumes persist across `docker compose down` (never `down -v`
on this stack in production).

HTTP/3 (QUIC) is enabled via the `443:443/udp` port mapping; Caddy
negotiates it automatically for clients that support it and falls back to
HTTP/2 otherwise.

## Staging

Not implemented here - pattern only (see `infra/README.md` for the general
approach): a second compose project (`name: edge-staging` or similar) with
its own `.env` pointing `*_DOMAIN` vars at `staging.`-prefixed subdomains,
and either its own `edge`-equivalent network or, more simply, reusing
`edge` if the staging backend/supabase stacks also attach to it under
distinct service/container names. Left for whoever sets up staging to
design against real constraints (single VPS vs second VPS, shared vs
isolated Supabase, etc.) - not implemented as part of this task.

## Validation

```bash
cd infra/edge
cp .env.example .env   # fill in dummy or real values
docker compose --env-file .env config -q   # should exit 0

docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -e ACME_EMAIL=ops@example.com -e APP_DOMAIN=app.example.com \
  -e SITE_DOMAIN=example.com -e API_DOMAIN=api.example.com \
  -e SUPABASE_DOMAIN=supabase.example.com \
  caddy:2.11.4 caddy validate --config /etc/caddy/Caddyfile   # "Valid configuration"
```

## Destructive: full local reset

```bash
docker compose down -v
```

`-v` deletes `caddy-data` (ACME account key + every issued certificate) and
`caddy-config`. Only use this for a throwaway reset - on a real VPS this
means re-issuing every certificate from scratch, which is rate-limited by
Let's Encrypt.
