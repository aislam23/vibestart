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

Playwright E2E is not wired up yet in this workspace - it lands in a follow-up task.
