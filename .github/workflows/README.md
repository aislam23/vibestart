# .github/workflows

Two workflows: `ci.yml` (every PR and every push to `main`) and
`deploy.yml` (every `v*` tag push, or a manual `workflow_dispatch` run).
See the header comment in each file for what each job does; this README
covers the secrets/variables `deploy.yml` needs, how to provision them, and
the release layout it maintains on the VPS. `ci.yml` needs none - it never
talks to anything outside the runner.

## Why this workflow never interpolates `${{ github.* }}` directly into `run:`

Every value that originates from the triggering event (`github.ref_name`,
`github.event.*`, the `sha` workflow_dispatch input, ...) is attacker- or
at-least-triggerer-controlled text - anyone who can push a tag or trigger a
manual run controls exactly what that string contains. Interpolating it
directly into a `run:` YAML block (`${{ github.ref_name }}` sitting inside
the shell script text) lets that text be interpreted as shell syntax -
GitHub's own security guidance calls this out as a script-injection vector.
Every such value in both workflows is instead read into an `env:` entry
first and referenced as a quoted shell variable (`"$REF_NAME"`, never bare
`$REF_NAME` or the raw `${{ }}` expression) inside `run:` - see
`deploy.yml`'s `validate` job for the canonical example.

## Deploy target validation (`validate` job)

`deploy.yml` never deploys a ref by name alone - it resolves and validates
an exact commit before `build-push`/`deploy` ever run:

- **Tag push**: `github.ref_name` must match strict SemVer
  `^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$` (e.g. `v1.2.3`, `v1.2.3-rc.1`)
  or the job fails closed before building anything.
- **`workflow_dispatch`**: requires an explicit `sha` input - a full
  40-character commit SHA, never a branch name - so a manual run can't
  silently deploy whatever a branch happens to point at right now.
- **Ancestry**: the resolved commit must be `git merge-base --is-ancestor`
  of `origin/main` - a commit that isn't part of `main`'s history (an
  unmerged branch, a force-pushed-away commit) is refused.
- **CI status**: a successful `ci.yml` run must exist for that exact commit
  (checked via `gh api .../actions/workflows/ci.yml/runs?head_sha=...`) -
  `deploy.yml` does not re-run tests itself; it refuses to deploy a commit
  CI never validated.

Only after all four checks pass does `build-push` build an image, and only
after the `production` environment gate (below) does `deploy` roll it out.

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
| `GHCR_PULL_TOKEN` | A GitHub PAT (classic or fine-grained) scoped to `read:packages` only, for the VPS itself to `docker login ghcr.io` and pull the backend image - GHCR packages are **not** assumed public. Create a dedicated token for this (not a personal PAT you use elsewhere) so it can be rotated/revoked independently. |

## Repository variables (Settings -> Secrets and variables -> Actions -> Variables)

Not secret, but still worth scoping to the `production` environment for
the connection details (`SSH_HOST`/`SSH_USER`/`DEPLOY_PATH`) so they stay
next to the secrets they pair with.

| Variable | Example | Notes |
|---|---|---|
| `SSH_HOST` | `vps.example.com` | The VPS's public hostname or IP. |
| `SSH_USER` | `deploy` | See "Least-privilege deploy user" below - never `root`. |
| `DEPLOY_PATH` | `/opt/vibestart` | Absolute path on the VPS that owns the versioned release layout below (`releases/`, `current`, and the stable `infra/*/.env` files) - see "Release layout on the VPS". No default - the workflow fails loudly if unset. |
| `GHCR_PULL_USER` | your GitHub username, or a machine-user's | Paired with the `GHCR_PULL_TOKEN` secret above for the VPS's `docker login ghcr.io` - GHCR accepts any non-empty username alongside a valid PAT, but use the token's actual owner for clarity when auditing. |
| `VITE_SUPABASE_URL` | `https://supabase.example.com` | Public Supabase URL, baked into the webapp build. Same value as `webapp/.env.example`'s `VITE_SUPABASE_URL`, but the production one. |
| `VITE_SUPABASE_ANON_KEY` | `ANON_KEY` from `infra/supabase/.env` on the VPS | Safe to expose to the browser (see `webapp/.env.example`'s comment) - still worth keeping as a variable, not hardcoding in the workflow, so a key rotation doesn't need a code change. |
| `VITE_API_URL` | `https://api.example.com` | Public backend URL - matches `infra/edge/.env`'s `API_DOMAIN`. |
| `PUBLIC_WEBSITE_URL` | `https://example.com` | Canonical URL baked into the Astro build's `<link rel="canonical">`/OpenGraph tags - see `website/README.md`. Matches `infra/edge/.env`'s `SITE_DOMAIN`. |
| `PUBLIC_WEBAPP_URL` | `https://app.example.com` | If set, the website's hero CTA links straight to the webapp instead of the local "how it works" anchor - see `website/src/lib/landing-actions.ts`. Matches `infra/edge/.env`'s `APP_DOMAIN`. Must be `https://` in production - `landing-actions.ts` rejects any other scheme. |
| `PUBLIC_REPO_URL` | `https://github.com/<owner>/<repo>` | This project's own repository URL, baked into the website's "View the template on GitHub" CTA. **Required** in practice - `deploy.yml` builds the website with `PUBLIC_SITE_ENV=production`, and `website/astro.config.mjs`'s production build gate fails the build if this is unset or still the template's own placeholder. |

## Release layout on the VPS

`deploy.yml` maintains a versioned release directory instead of overwriting
static builds and the app compose file in place, so a failed deploy can
always be rolled back and Caddy always serves a fully-consistent release,
never a half-synced one:

```
$DEPLOY_PATH/
  infra/app/.env          # stable, hand-maintained secrets - never touched by CI
  infra/edge/.env         # stable, hand-maintained
  infra/backup/.env       # stable, hand-maintained
  infra/supabase/.env     # stable, hand-maintained
  infra/edge/              # stable edge stack - NOT re-synced per release, see below
  infra/app/image.env     # atomically rewritten every deploy (tmp file + rename)
  deploy.lock              # flock target - serializes deploys against each other
  releases/
    <commit-sha>/
      infra/...             # this commit's compose files + Caddyfile, versioned
      Makefile
      webapp/dist/
      website/dist/
  current -> releases/<commit-sha>   # flipped atomically, only after a health pass
```

`infra/edge` itself is deliberately **not** part of the versioned bundle -
the edge/Caddy stack has its own slower-moving lifecycle (see
`infra/edge/README.md`) and is brought up/updated independently. Its
compose file's bind mount (`infra/edge/docker-compose.yml`) points at the
STABLE `../../releases` directory, with `releases/current` as the symlink
inside it that this workflow flips - Caddy's `file_server` re-resolves that
symlink on every request, so a new release's static files appear without a
Caddy restart. See `infra/edge/docker-compose.yml`'s volumes comment and
`docs/DEPLOYMENT.md`, "Clean-VPS deploy order" for the one-time setup
(`mkdir -p releases` before the first `edge-up`).

Only `infra/app/.env` (and the other stacks' `.env` files) live outside any
one release, hand-maintained once per `docs/DEPLOYMENT.md`'s first-deploy
sequence - CI never writes them.

## Least-privilege deploy user

The SSH user `deploy.yml` connects as needs exactly three things on the
VPS, nothing more:

- Membership in the `docker` group (to run `docker compose`) - **not**
  passwordless `sudo`. Docker group membership is already
  root-equivalent on that host (a well-known Docker caveat, not specific
  to this template) - accept that as the cost of running Docker at all,
  but don't compound it with unrelated sudo rights.
- Write access to `$DEPLOY_PATH/releases/`, `$DEPLOY_PATH/current`
  (the release symlink), `$DEPLOY_PATH/deploy.lock`, and
  `$DEPLOY_PATH/infra/app/image.env` - see "Release layout on the VPS"
  above and `infra/app/README.md`, "Deploying from CI". It never needs
  write access to any `infra/*/.env` file - those are hand-maintained.
- Read access to the rest of `$DEPLOY_PATH` (it runs `docker compose -f
  releases/<sha>/infra/app/docker-compose.yml ...` from there).

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
