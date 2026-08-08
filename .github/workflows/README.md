# .github/workflows

Two workflows: `ci.yml` (every PR and every push to `main`) and
`deploy.yml` (every `v*` tag push, or a manual `workflow_dispatch` run).
See the header comment in each file for what each job does; this README
covers the secrets/variables `deploy.yml` needs and how to provision them.
`ci.yml` needs none - it never talks to anything outside the runner.

## Repository secrets (Settings -> Secrets and variables -> Actions -> Secrets)

Scope these to the `production` environment (Settings -> Environments ->
`production` -> Environment secrets) rather than repository-wide, so a
workflow run from an arbitrary branch can never read them without also
matching `deploy.yml`'s `environment: production` gate - required
reviewers on that environment add a manual approval step in front of every
deploy, if you want one.

| Secret | Value |
|---|---|
| `SSH_KEY` | Private half of a dedicated deploy keypair (`ssh-keygen -t ed25519 -f deploy_key -C vibestart-deploy`, no passphrase - GitHub Actions can't type one). Add the public half to the deploy user's `~/.ssh/authorized_keys` on the VPS, restricted with `command=`/`from=` if your `sshd` config supports it. Never reuse a personal key. |
| `SSH_KNOWN_HOSTS` | Output of `ssh-keyscan -H <your-vps-host>` run **once**, from a machine you trust, over a channel you trust (e.g. right after provisioning the VPS, before it's ever handled anything sensitive) - paste the full multi-line output as-is. This pins the host key so the deploy step fails closed on a MITM/host-key-changed situation instead of silently trusting whatever key answers at deploy time. |

## Repository variables (Settings -> Secrets and variables -> Actions -> Variables)

Not secret, but still worth scoping to the `production` environment for
the connection details (`SSH_HOST`/`SSH_USER`/`DEPLOY_PATH`) so they stay
next to the secrets they pair with.

| Variable | Example | Notes |
|---|---|---|
| `SSH_HOST` | `vps.example.com` | The VPS's public hostname or IP. |
| `SSH_USER` | `deploy` | See "Least-privilege deploy user" below - never `root`. |
| `DEPLOY_PATH` | `/opt/vibestart` | Absolute path to this repo's checkout on the VPS - must contain `webapp/dist`, `website/dist`, and `infra/app/.env` already, per `infra/README.md`'s VPS bootstrap checklist. No default - the workflow fails loudly if unset. |
| `VITE_SUPABASE_URL` | `https://supabase.example.com` | Public Supabase URL, baked into the webapp build. Same value as `webapp/.env.example`'s `VITE_SUPABASE_URL`, but the production one. |
| `VITE_SUPABASE_ANON_KEY` | `ANON_KEY` from `infra/supabase/.env` on the VPS | Safe to expose to the browser (see `webapp/.env.example`'s comment) - still worth keeping as a variable, not hardcoding in the workflow, so a key rotation doesn't need a code change. |
| `VITE_API_URL` | `https://api.example.com` | Public backend URL - matches `infra/edge/.env`'s `API_DOMAIN`. |
| `PUBLIC_WEBSITE_URL` | `https://example.com` | Canonical URL baked into the Astro build's `<link rel="canonical">`/OpenGraph tags - see `website/README.md`. Matches `infra/edge/.env`'s `SITE_DOMAIN`. |
| `PUBLIC_WEBAPP_URL` | `https://app.example.com` | If set, the website's hero CTA links straight to the webapp instead of the local "how it works" anchor - see `website/src/lib/landing-actions.ts`. Matches `infra/edge/.env`'s `APP_DOMAIN`. |

## Least-privilege deploy user

The SSH user `deploy.yml` connects as needs exactly three things on the
VPS, nothing more:

- Membership in the `docker` group (to run `docker compose`) - **not**
  passwordless `sudo`. Docker group membership is already
  root-equivalent on that host (a well-known Docker caveat, not specific
  to this template) - accept that as the cost of running Docker at all,
  but don't compound it with unrelated sudo rights.
- Write access to `$DEPLOY_PATH/webapp/dist`, `$DEPLOY_PATH/website/dist`,
  and `$DEPLOY_PATH/infra/app/` (for `image.env` - see
  `infra/app/README.md`, "Deploying from CI").
- Read access to the rest of `$DEPLOY_PATH` (it runs `docker compose -f
  infra/app/docker-compose.yml ...` from there).

Nothing outside `$DEPLOY_PATH` - don't reuse this user/key for anything
else on the box (backups, other projects, general shell access).

## Workflow lint / validation

```bash
# actionlint, if installed (brew install actionlint / brew list actionlint)
actionlint .github/workflows/ci.yml .github/workflows/deploy.yml

# otherwise, at minimum, a YAML parse of both files:
bun -e "import { parse } from 'yaml'; import { readFileSync } from 'node:fs'; \
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/deploy.yml']) { \
    parse(readFileSync(f, 'utf8')); console.log(f, 'parses OK'); \
  }"

# compose files this repo's CI/deploy touch:
docker compose -f backend/docker-compose.test.yml config -q
docker compose -f infra/app/docker-compose.yml config -q            # should FAIL - BACKEND_IMAGE unset
cd infra/app && cp .env.example .env && docker compose --env-file .env config -q && rm .env
```

## What's unproven until the first real push/tag

- Both workflows are YAML-parsed and their referenced compose files
  `config`-validated locally (see above), and `ci.yml`'s steps are each
  the same commands already exercised locally during this task - but
  GitHub Actions' actual runner environment (exact preinstalled Docker/
  Compose version, network egress, cache hit behavior, GHCR auth) is only
  proven once `ci.yml` runs for real on a pushed branch/PR.
- `deploy.yml` additionally needs: the secrets/variables above actually
  provisioned, a real reachable VPS with `infra/app`/`infra/edge` already
  bootstrapped per `infra/README.md`, and a `v*` tag or manual dispatch to
  trigger it - none of that exists yet at this point in the project
  (T8 pushes the repository to GitHub and does the first real deploy).
