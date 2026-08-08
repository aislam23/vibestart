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
  jwtSecret: string
  kongPort: number
  postgresPassword: string
  postgresPort: number
  runtimeDatabaseUrl: string
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

/** Starts from infra/supabase/.env.example (the same template `generate-secrets.ts` uses) and
 * substitutes this run's generated secrets plus the port/URL overrides that isolate this stack
 * from the dev one. Every other key (SMTP, storage backend, phone auth, ...) keeps its dev-mode
 * default from .env.example - this stack only ever starts `db`, `auth`, and `kong`. */
function buildSupabaseEnvContent(plan: E2ePlan, secrets: E2eSecrets): string {
  const examplePath = resolve(supabaseRoot, '.env.example')
  const lines = readFileSync(examplePath, 'utf8').split('\n')

  const overrides: Record<string, string> = {
    POSTGRES_PASSWORD: secrets.postgresPassword,
    JWT_SECRET: secrets.jwtSecret,
    ANON_KEY: secrets.anonKey,
    SERVICE_ROLE_KEY: secrets.serviceRoleKey,
    DASHBOARD_USERNAME: 'supabase',
    DASHBOARD_PASSWORD: secrets.dashboardPassword,
    REALTIME_DB_ENC_KEY: secrets.realtimeDbEncKey,
    SECRET_KEY_BASE: secrets.secretKeyBase,
    PG_META_CRYPTO_KEY: secrets.pgMetaCryptoKey,
    KONG_HTTP_PORT: String(plan.kongPort),
    POSTGRES_PORT: String(plan.postgresPort),
    SUPABASE_PUBLIC_URL: plan.supabaseUrl,
    API_EXTERNAL_URL: `${plan.supabaseUrl}/auth/v1`,
    // GOTRUE_SITE_URL / GOTRUE_URI_ALLOW_LIST: ForgotPasswordForm's `resetPasswordForEmail` sends
    // `redirectTo: ${window.location.origin}/reset-password` - GoTrue rejects any redirect target
    // outside SITE_URL/this allow list, so both must point at the e2e webapp origin or that call
    // fails for every email, not just ones that exist.
    SITE_URL: plan.webUrl,
    ADDITIONAL_REDIRECT_URLS: `${plan.webUrl}/**`,
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
