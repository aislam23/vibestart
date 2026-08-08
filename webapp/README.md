# Webapp

The CSR browser client provides authenticated, role-specific workspaces. It needs no SEO, so it stays client-side rendered; the public, SEO-facing surfaces live in the `website` workspace instead. It consumes the same API contracts as any future mobile client and keeps server-state, form-state, auth, and role navigation centralized.

## Stack

- React
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui
- Radix UI
- TanStack Query
- TanStack Form
- TanStack Router
- `@supabase/supabase-js`
- Zod contracts from `@vibestart/contracts`
- shadcn CLI
- ESLint

## Commands

```bash
bun run dev
bun run build
bun run typecheck
bun run lint
bun run test
bun run ui:info
```

From the repository root, use `bun run dev:webapp`, `bun run build:webapp`, `bun run typecheck:webapp`, and `bun run test:webapp`.

## Setup

The webapp needs the self-hosted Supabase stack and the backend running against it:

```bash
make supabase-up            # from the repo root - starts infra/supabase
bun run --cwd backend prisma:deploy
bun run dev:backend
cp webapp/.env.example webapp/.env   # fill VITE_SUPABASE_ANON_KEY from infra/supabase/.env
bun run dev:webapp
```

## Env

Create `webapp/.env`:

| Variable | Required | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | yes | Public URL of the self-hosted Supabase stack (Kong), e.g. `http://localhost:54321`. |
| `VITE_SUPABASE_ANON_KEY` | yes | The `ANON_KEY` from `infra/supabase/.env`. Safe to expose to the browser - it is the public, row-level-security-scoped key, never the service role key. |
| `VITE_API_URL` | yes | The backend origin, e.g. `http://localhost:3000`. Build-time config; changing it in production requires a redeploy of the built bundle. |

## Auth architecture

Auth is not custom here - `@supabase/supabase-js` owns the whole client-side session lifecycle: signup, login, logout, password reset, token storage (`localStorage`, default persistence), and automatic access-token refresh. There are no cookies and no `/api/auth/*` routes on the backend; the browser talks to Supabase Auth (GoTrue, via Kong) directly, then sends the resulting access token to the backend as `Authorization: Bearer <jwt>`.

The backend owns roles, not Supabase: `role` (`user | admin`) lives in the backend's own `profiles` table and is read fresh on every request from `GET /api/users/me`, never from the JWT. `src/features/auth/provider.tsx` is the client golden path - it mirrors `supabase.auth.getSession()`/`onAuthStateChange()` into React state, and once a session exists, fetches `/api/users/me` (TanStack Query) to get the app-level `UserDto` with role.

`src/platform/api/authenticated-transport.ts` builds the authorized HTTP client generically (`platform` never imports product features, see `docs/ARCHITECTURE.md`): it takes async `getAccessToken`/`refreshAccessToken` functions and retries a request exactly once after a 401, refreshing first; a repeated 401 signs the session out. `AuthProvider` composes this transport with supabase-js-backed token getters - the injection happens in `features/auth`, not in `platform`.

Password reset: `requestPasswordReset` calls `supabase.auth.resetPasswordForEmail` with `redirectTo` pointing back at `/reset-password`. Supabase parses the reset link's token out of the URL automatically on load (`detectSessionInUrl`, the default) and fires a `PASSWORD_RECOVERY` auth event, which `AuthProvider` observes as `isPasswordRecovery`; `ResetPasswordForm` reads that flag instead of taking a token prop, and submits via `supabase.auth.updateUser({ password })`.

Registration: local dev has Supabase email autoconfirm on, so `supabase.auth.signUp` returns a session immediately and the guest-only routes (`/login`, `/signup`, `/forgot-password`) redirect away as soon as it lands. A production deployment with real SMTP requires email confirmation first - `signUp` then returns no session, `RegisterForm` shows a "check your email" screen instead of redirecting.

**Removed from the source template:** the source's `SessionPanel` (a "current session" card with a logout button on the settings page) assumed a backend-issued, listable session store. Supabase does not expose an active-sessions list to browser clients, so there is nothing to render there - it was removed along with its plumbing (`UserSettings` no longer takes an `onLogout` prop). Logout is still available from the workspace sidebar's account menu (`NavUser`).

The route map, workspace shell, admin/user feature split, and architecture rules (`platform`/`components/ui` never import product features; cross-feature imports go through a feature's public `index.ts`; run `bun run architecture:check` after changing boundaries) are unchanged from the shared frontend conventions in `docs/ARCHITECTURE.md`.

## E2E

Playwright (`webapp/e2e/`) runs full-stack smoke tests: a real self-hosted Supabase stack, the
backend, and Vite, driven through Chromium. It covers two happy-path journeys plus the RBAC
redirects - not validation matrices (those live in backend integration tests and `webapp/tests`).

- `e2e/specs/auth.spec.ts` - register via the UI (Supabase email autoconfirm is on for e2e, so
  signup lands straight in `/app`), see the profile panel and update the display name, log out,
  log back in; the forgot-password screen renders and accepts a request (no SMTP is configured for
  e2e - the target email is always unregistered, so GoTrue's anti-enumeration branch returns
  success without ever touching a mailer).
- `e2e/specs/rbac.spec.ts` - an admin, seeded in `globalSetup`, opens `/admin`, promotes a regular
  user from the user directory, and the change takes effect on that user's very next request (no
  session revocation - see backend/README.md, "No session revocation on a role change"); a
  regular user visiting `/admin` and an admin visiting `/app` both redirect home.

Everything the run needs is isolated and throwaway, entirely separate from `infra/supabase`'s dev
stack:

- `docker compose -p vibestart-e2e` brings up only `db`, `auth`, and `kong` from
  `infra/supabase/docker-compose.yml`, plus `e2e/docker-compose.e2e-override.yml` (renames the
  three services' `container_name` and the `supabase` network so they never collide with the dev
  stack's identically-named ones - see that file's header comment).
- A throwaway `infra/supabase`-shaped `.env` and generated secrets live only in
  `webapp/e2e/.artifacts/` (gitignored) - `infra/supabase/.env` is never read or written.
- The backend runs against `backend_runtime` (activated with a freshly generated password, same as
  a real deploy - backend/README.md, "Runtime DB role"), not the migration superuser.
- Ports (Kong, Postgres, backend, Vite) auto-select near fixed preferred values
  (`webapp/e2e/env.ts`/`ports.ts`) and move to the next free one if occupied.
- `globalTeardown` runs `docker compose -p vibestart-e2e down -v` (the one place `-v` is
  correct here - this project's volumes never hold anything worth keeping) and deletes the
  scratch secrets; the HTML report and `test-results/` (traces/screenshots/video) survive for
  inspection.

Run it:

```bash
bun run --cwd webapp e2e:install   # once, installs the Chromium browser Playwright drives
bun run e2e:webapp                 # from the repo root; needs Docker running
```

Useful env: `E2E_KONG_PORT` / `E2E_POSTGRES_PORT` / `E2E_BACKEND_PORT` / `E2E_WEB_PORT` (pin a
port instead of auto-selecting), `E2E_KEEP_DOCKER=1` (skip the `docker compose down -v` teardown,
for debugging), `E2E_KEEP_SCRATCH_FILES=1` (keep the generated `.env`/`plan.json`).

Not part of the default `bun run test` chain (it needs Docker and takes noticeably longer) - run
it as its own step, the same way `bun run test:backend:integration` is separate from
`bun run test:backend`.
