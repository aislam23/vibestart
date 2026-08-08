import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { artifactsDir, planFilePath, scratchSupabaseEnvPath, supabaseRoot } from './env'
import { resolveE2ePorts } from './ports'
import { generateE2eSecrets, type E2eSecrets } from './secrets'

export type E2ePlan = {
  anonKey: string
  backendPort: number
  backendRuntimePassword: string
  backendUrl: string
  dashboardPassword: string
  jwtSecret: string
  kongPort: number
  postgresPassword: string
  postgresPort: number
  runtimeDatabaseUrl: string
  serviceRoleKey: string
  superuserDatabaseUrl: string
  supabaseUrl: string
  webPort: number
  webUrl: string
}

/**
 * Computes ports and secrets exactly once per Playwright run and persists them to two scratch
 * files (see env.ts): the throwaway `infra/supabase`-shaped .env `docker compose` reads, and a
 * small JSON coordination file.
 *
 * The JSON file exists because Playwright starts the `webServer` entries declared in
 * playwright.config.ts BEFORE running `global-setup.ts` (confirmed against the installed
 * @playwright/test's documented lifecycle: webServer, then globalSetup, then tests) - so
 * global-setup.ts runs in a process that can no longer influence what the backend/web servers
 * were already launched with. Both call this same plan through `readE2ePlan()` so they agree on
 * every port, password, and key without recomputing (and by construction never diverging from)
 * fresh random values.
 *
 * That same JSON file also has to survive `playwright.config.ts` itself being evaluated more than
 * once within a single `playwright test` invocation (observed in practice: a second evaluation's
 * port scan found the first one's already-started `web` webServer bound to its port and picked
 * the very next one, silently splitting the port the server actually listened on from the port
 * `use.baseURL`/tests navigated to). So this function is idempotent within one run: if a plan is
 * already on disk, it is reused as-is instead of generating a second, different one.
 * global-teardown.ts deletes both scratch files at the end of every run, so a stale plan can only
 * ever be reused across runs if teardown itself did not get to run (e.g. the process was killed) -
 * in that case reusing it just re-targets whatever that interrupted run's own stack was using,
 * which is the correct thing to reattach to (or, if that stack is already gone, `docker compose
 * up` simply recreates it on the same recorded ports/secrets).
 */
export async function resolveAndPersistE2ePlan(): Promise<E2ePlan> {
  if (existsSync(planFilePath)) return readE2ePlan()

  const ports = await resolveE2ePorts()
  const secrets = generateE2eSecrets()

  const supabaseUrl = `http://127.0.0.1:${ports.kongPort}`
  const backendUrl = `http://127.0.0.1:${ports.backendPort}`
  const webUrl = `http://127.0.0.1:${ports.webPort}`
  // `supabase_admin`, not `postgres`: in this self-hosted Supabase Postgres image, `postgres` is
  // NOT an actual superuser (`\du` shows only `supabase_admin` with the `Superuser` attribute) -
  // it lacks GRANT OPTION on the `auth` schema, so the backend_runtime_role migration's
  // `GRANT USAGE ON SCHEMA auth TO backend_runtime` silently no-ops (a Postgres WARNING, not an
  // error - `prisma migrate deploy` reports success either way) when run through `postgres`,
  // leaving `backend_runtime` unable to read `auth.users` at all despite the column-level grant
  // otherwise "succeeding". backend/scripts/test-integration.mjs already avoids this by migrating
  // its own throwaway Postgres as `supabase_admin` - this matches that same precedent. Both share
  // POSTGRES_PASSWORD (infra/supabase/README.md, "Rotating secrets" lists `supabase_admin` among
  // the roles that rotate together with it).
  const superuserDatabaseUrl = `postgresql://supabase_admin:${secrets.postgresPassword}@127.0.0.1:${ports.postgresPort}/postgres?schema=public`
  const runtimeDatabaseUrl = `postgresql://backend_runtime:${secrets.backendRuntimePassword}@127.0.0.1:${ports.postgresPort}/postgres?schema=public`

  const plan: E2ePlan = {
    ...ports,
    supabaseUrl,
    backendUrl,
    webUrl,
    anonKey: secrets.anonKey,
    jwtSecret: secrets.jwtSecret,
    postgresPassword: secrets.postgresPassword,
    backendRuntimePassword: secrets.backendRuntimePassword,
    serviceRoleKey: secrets.serviceRoleKey,
    dashboardPassword: secrets.dashboardPassword,
    superuserDatabaseUrl,
    runtimeDatabaseUrl,
  }

  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(scratchSupabaseEnvPath, buildSupabaseEnvContent(plan, secrets), { mode: 0o600 })
  writeFileSync(planFilePath, JSON.stringify(plan, null, 2), { mode: 0o600 })

  return plan
}

export function readE2ePlan(): E2ePlan {
  return JSON.parse(readFileSync(planFilePath, 'utf8')) as E2ePlan
}

/**
 * The `docker compose` interpolation variables that the `db`, `auth`, and `kong` services - the
 * only ones global-setup.ts ever brings up - actually read from the environment, keyed exactly as
 * `infra/supabase/docker-compose.yml`'s `${VAR}` references expect. Exported (not just inlined
 * into {@link buildSupabaseEnvContent} below) because {@link composeEnv} also needs it - see that
 * function's doc comment for why every `docker compose` invocation in global-setup.ts/
 * global-teardown.ts passes an explicit process env built from this instead of inheriting
 * `process.env`.
 */
export function composeInterpolationEnv(plan: E2ePlan): Record<string, string> {
  return {
    POSTGRES_PASSWORD: plan.postgresPassword,
    JWT_SECRET: plan.jwtSecret,
    ANON_KEY: plan.anonKey,
    SERVICE_ROLE_KEY: plan.serviceRoleKey,
    DASHBOARD_USERNAME: 'supabase',
    DASHBOARD_PASSWORD: plan.dashboardPassword,
    KONG_HTTP_PORT: String(plan.kongPort),
    POSTGRES_PORT: String(plan.postgresPort),
    SUPABASE_PUBLIC_URL: plan.supabaseUrl,
    API_EXTERNAL_URL: `${plan.supabaseUrl}/auth/v1`,
    // GOTRUE_SITE_URL / GOTRUE_URI_ALLOW_LIST: `requestPasswordReset` (webapp/src/features/auth/
    // provider.tsx) sends `redirectTo: ${origin}/auth/callback?next=...` - GoTrue rejects any
    // redirect target outside SITE_URL/this allow list, so both must point at the e2e webapp
    // origin (with a wildcard covering the `/auth/callback` path) or that call fails for every
    // email, not just ones that exist.
    SITE_URL: plan.webUrl,
    ADDITIONAL_REDIRECT_URLS: `${plan.webUrl}/**`,
  }
}

/**
 * The explicit, closed process env every `docker compose` invocation in global-setup.ts/
 * global-teardown.ts passes instead of inheriting the caller's `process.env`.
 *
 * `docker compose`'s variable interpolation prefers the *shell* environment over `--env-file`
 * (composeArgs in env.ts always passes `--env-file` pointing at the scratch supabase.env this
 * plan wrote) - so a `spawnSync(..., { env: process.env })` call would let a leftover or
 * deliberately poisoned host-shell `POSTGRES_PASSWORD`/`JWT_SECRET`/etc. silently win over this
 * run's freshly generated ones, defeating the isolation the rest of this file exists to provide.
 * Building the env from nothing but this plan's own values closes that off entirely: there is
 * nothing in the process env for the shell to have poisoned in the first place.
 *
 * `PATH`/`HOME` are passed through as-is (needed to find the `docker` binary and Docker's own
 * config/credentials store); `DOCKER_HOST`/`DOCKER_CONTEXT`/`DOCKER_CONFIG` are passed through too
 * when set, so this still works on setups where the Docker CLI needs them to find the daemon at
 * all (Colima, OrbStack, a non-default context) - none of those name a compose interpolation
 * variable, so letting them through cannot reintroduce the leak this function exists to close.
 */
export function composeEnv(plan: E2ePlan): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...composeInterpolationEnv(plan) }
  for (const passthroughVar of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    const value = process.env[passthroughVar]
    if (value !== undefined) env[passthroughVar] = value
  }
  return env
}

/** Starts from infra/supabase/.env.example (the same template `generate-secrets.ts` uses) and
 * substitutes this run's generated secrets plus the port/URL overrides that isolate this stack
 * from the dev one. Every other key (SMTP, storage backend, phone auth, ...) keeps its dev-mode
 * default from .env.example - this stack only ever starts `db`, `auth`, and `kong`. */
function buildSupabaseEnvContent(plan: E2ePlan, secrets: E2eSecrets): string {
  const examplePath = resolve(supabaseRoot, '.env.example')
  const lines = readFileSync(examplePath, 'utf8').split('\n')

  const overrides: Record<string, string> = {
    ...composeInterpolationEnv(plan),
    // Unused by `db`/`auth`/`kong` (the only services e2e starts) but generated for parity, so the
    // scratch .env stays valid if that ever changes.
    REALTIME_DB_ENC_KEY: secrets.realtimeDbEncKey,
    SECRET_KEY_BASE: secrets.secretKeyBase,
    PG_META_CRYPTO_KEY: secrets.pgMetaCryptoKey,
  }

  return lines
    .map((line) => {
      const match = /^([A-Z0-9_]+)=/.exec(line)
      if (!match) return line
      const key = match[1]
      return key in overrides ? `${key}=${overrides[key]}` : line
    })
    .join('\n')
}
