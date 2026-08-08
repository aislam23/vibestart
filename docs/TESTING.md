# Testing

The unit/integration/e2e/architecture contract for this repository: what each layer covers, the
exact commands, and what CI actually runs. Per-surface testing detail (specific test files, fixture
shape) stays in `backend/README.md` and `webapp/README.md`; this document is the cross-cutting
picture.

## The four layers

Cheapest and fastest first — run the cheap layer constantly, the expensive layers before merging.

### 1. Unit — `bun run test`

No database, no Docker. Every module test uses a fake Prisma client or a `jose`-signed test JWT.
Runs, in order:

```bash
bun run test:contracts       # packages/contracts — bun test src
bun run test:backend         # backend — bun test src
bun run test:webapp          # webapp — its own test runner
bun run test:website         # website — its own test runner
bun run test:architecture    # scripts/architecture-check.test.mjs — tests the checker itself
bun run architecture:check   # scripts/architecture-check.mjs — the actual boundary check (see docs/ARCHITECTURE.md)
```

This is what CI's `test` job runs, alongside `bun run typecheck`, `bun run lint`, and `bun run
build`.

### 2. Backend integration — `bun run test:backend:integration`

Needs Docker. Starts a throwaway Postgres (`backend/docker-compose.test.yml`, service `db_test`,
port `127.0.0.1:54329` — **not** the dev Supabase stack on 54322), applies `backend/prisma/migrations`
as the migration superuser, activates the `backend_runtime` role (see `docs/ARCHITECTURE.md`,
"Data model conventions"), and runs every `*.integration.test.ts` file's app-facing requests
through it. Tears the container down with `docker compose down --volumes` afterward — the one place
in the repository a `-v` teardown is correct, since `db_test` never holds anything worth keeping.

`db_test` runs a minimal stub `auth.users(id, email)` table instead of real Supabase Auth — just
enough for the admin directory's read-only join to work against real Postgres.

CI runs this as its own job step (needs Docker, takes longer than the unit suite) — not folded into
`bun run test`.

### 3. Webapp e2e — `bun run e2e:webapp`

Needs Docker. Playwright, driven through Chromium, against a **fully isolated** stack: a real,
throwaway Supabase (`db`, `auth`, `kong` only — `docker compose -p vibestart-e2e`), the real
backend running against `backend_runtime`, and Vite. Everything lives under `webapp/e2e/.artifacts/`
(gitignored) and is torn down (`down -v`) after the run; `infra/supabase/.env` is never read or
touched.

**This suite is happy-path smoke, not a validation matrix.** It covers a handful of full journeys
(register → see profile → update display name → log out → log back in; forgot-password renders and
accepts a request; a real password-recovery round trip via a generated GoTrue admin link) plus RBAC
redirects (admin promotes a user, the change takes effect on that user's very next request; a
regular user visiting `/admin` and an admin visiting `/app` both redirect home). Validation
matrices, edge cases, and error-shape assertions live in backend integration tests and
`webapp/tests` instead — e2e is deliberately not where that coverage lives, because it's the
slowest, most Docker-dependent layer to run and iterate on.

Runs are serialized per machine (an exclusive lock file) — a second concurrent `bun run e2e:webapp`
fails fast instead of two runs fighting over the same fixed container names. CI runs this as a
separate job from the main `test` job, with its own Playwright browser cache.

### 4. Docker smoke — `bun run smoke:backend:docker`

Needs Docker. Builds the real `backend/Dockerfile`, runs the image against `db_test`, and asserts
`GET /health/ready` returns `200` — the same check a container orchestrator's readiness probe would
make. Not run in CI today (see `.github/workflows/ci.yml`); run it locally before a release that
touches the Dockerfile or the runtime bootstrap.

## Architecture check

`bun run architecture:check` (`scripts/architecture-check.mjs`) statically enforces the module
boundaries described in `docs/ARCHITECTURE.md`: backend layer dependencies, backend module public-API
boundaries, webapp/website feature and platform-direction boundaries, and the contracts
dependency-direction rule. It's regex-based, not a full parser — deliberately conservative (broad
patterns, dedicated bypass fixtures in its own test file) rather than exhaustive. Run it whenever
module, feature, contracts, or platform boundaries change; it's also part of `bun run test`.

## What CI runs

`.github/workflows/ci.yml` — every PR and every push to `main`:

- **`test` job**: `bun install --frozen-lockfile` → `bun run typecheck` → `bun run lint` →
  `bun run test` (layer 1 above) → `bun run test:backend:integration` (layer 2, its own step
  since it needs Docker) → `bun run build`.
- **`e2e` job**: installs Playwright's Chromium (cached, keyed on `bun.lock`) → `bun run
  e2e:webapp` (layer 3) → uploads the HTML report as an artifact on failure.

Both jobs run in parallel; `ci.yml` needs no secrets — it never talks to anything outside the
runner. `.github/workflows/deploy.yml` does not re-run tests; it assumes `ci.yml` already passed on
the commit being tagged.

## Lint and typecheck

`bun run lint` runs `webapp`'s ESLint config (the only workspace with a dedicated lint script
today). `bun run typecheck` runs `--filter '*' --sequential typecheck` across every workspace —
backend's typecheck also regenerates the Prisma client first (`prisma generate`, using a
placeholder `DATABASE_URL` when unset, so no real database is required).

## See also

- `backend/README.md`, "Testing" — the byte-level detail on the integration-test harness, its
  destructive-teardown safety checks, and the runtime-role activation it exercises.
- `webapp/README.md`, "E2E" — the full e2e harness: port auto-selection, the run-lock mechanism,
  `E2E_KEEP_DOCKER`/`E2E_KEEP_SCRATCH_FILES` for debugging a failed run.
- `docs/ARCHITECTURE.md` — the module boundaries `architecture:check` enforces.
