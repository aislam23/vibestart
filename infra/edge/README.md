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
                +---------------------------+
                |  caddy (edge + app_edge)  |
                +---------------------------+
                    /       |       \  \
                   /        |        \  \
      {$APP_DOMAIN}  {$SITE_DOMAIN}  {$API_DOMAIN}   {$SUPABASE_DOMAIN}
      root /srv/current/  root /srv/current/  |               |
        webapp/dist         website/dist      v               v
      (bind mount of      (bind mount of  reverse_proxy    reverse_proxy
       releases/, see      releases/)     backend:3000      kong:8000
       docker-compose.yml)                (app_edge          (edge network,
                                            network, T5)       infra/supabase)
```

Two Docker networks are provisioned independently of any single stack
(`make ensure-network`, or `docker network create edge && docker network
create app_edge` directly):

- **`edge`** - this stack and `infra/supabase`'s `kong` service attach as
  `external: true` from their own compose projects.
- **`app_edge`** - this stack and (starting T5) `infra/app`'s `backend`
  service attach as `external: true`. Kept separate from `edge`
  deliberately, so `backend` can't reach `kong` (or any future
  edge-facing service) over the network layer if compromised - see
  `infra/app/README.md`, "Network segmentation".

Either way, any stack can start or stop in any order without owning or
having to pre-create either network for the others. Caddy reaches the
others by service name. `db`, `auth`, `rest`, `realtime`, `storage`,
`meta`, and `studio` never join `edge`/`app_edge` and stay unreachable
from outside their own compose network - Studio in particular is reached
**only** through Kong's `dashboard` route (basic-auth), never proxied
directly (see `infra/supabase/README.md`).

## First run on a VPS

1. **DNS**: create A (and AAAA if you have IPv6) records pointing
   `APP_DOMAIN`, `SITE_DOMAIN`, `API_DOMAIN`, and `SUPABASE_DOMAIN` at the
   VPS's public IP before bringing the stack up - see "How TLS/ACME works"
   below for why this has to come first.
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
4. **Bring the stacks up**: `make up` from the repo root (this also runs
   `make ensure-network`, which creates both the `edge` and `app_edge`
   networks if they don't exist yet). Both networks are provisioned
   independently of any one stack, so `infra/supabase`, `infra/app`, and
   `infra/edge` can each be started or stopped in any order, on a fresh
   VPS or afterwards - there's no required first-boot order between them.
5. Bring the edge stack up with `docker compose up -d --wait` (or
   `make edge-up`, which does the same) so the command doesn't return until
   Caddy's healthcheck passes, then run an external HTTPS smoke check
   (`curl -I https://your-domain`) once DNS has propagated to confirm a
   real cert was issued - see "How TLS/ACME works" below.

## How TLS/ACME works

Caddy's `email` global option (from `ACME_EMAIL`) registers with Let's
Encrypt. Certificate issuance is **asynchronous**: Caddy requests a cert
for every `{$..._DOMAIN}` site block as soon as it loads its config (i.e.
on `docker compose up`, not on first request), and keeps retrying in the
background on failure (e.g. DNS not resolved yet) without the container
exiting or the healthcheck failing - so a host with unresolved DNS just
stays uncertified until DNS catches up, it doesn't block the others or
crash the stack. Issued certs are renewed automatically before expiry and
cached in the `caddy-data` named volume (do not delete this volume
casually - it holds the ACME account key and every issued cert, and
hitting Let's Encrypt's rate limits while re-issuing is easy to trigger by
accident). `caddy-config` holds Caddy's runtime-adapted config state. Both
volumes persist across `docker compose down` (never `down -v` on this
stack in production).

HTTP/3 (QUIC) is enabled via the `443:443/udp` port mapping; Caddy
negotiates it automatically for clients that support it and falls back to
HTTP/2 otherwise.

## Hardening notes

- **Studio access**: the `{$SUPABASE_DOMAIN}` host sets `X-Frame-Options:
  SAMEORIGIN` (not `DENY`) so Studio's own embedded panels keep working;
  for a stricter setup, put Studio behind an IP allow-list or a VPN
  instead of relying on framing/basic-auth alone (pattern only - not
  implemented here).
- **Deploying webapp/website builds**: the `releases/` directory
  (containing every deploy's `webapp/dist`/`website/dist` plus the
  `current` symlink `.github/workflows/deploy.yml` flips - see
  `docker-compose.yml`'s volumes comment) is bind-mounted read-only -
  never include symlinks in a dist artifact you deploy there, since a
  symlink can point outside the mounted directory and Caddy will happily
  serve whatever it resolves to.

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
docker compose config -q   # should FAIL - the 5 required vars are unset

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
