import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

import { backendRoot } from './e2e/env'
import { resolveAndPersistE2ePlan } from './e2e/plan'
import { acquireRunLock } from './e2e/run-lock'

const frontendRoot = fileURLToPath(new URL('.', import.meta.url))

// Acquired here, before `resolveAndPersistE2ePlan()` - not inside globalSetup, which per
// plan.ts's doc comment runs too late to help: a second, concurrent invocation reaches THIS same
// config-eval step first, reuses the first run's still-on-disk plan.json (same ports), and fails
// with a confusing "port already in use" error from Playwright's own `webServer` startup well
// before globalSetup ever gets a chance to run. Acquiring the lock here instead means a
// concurrent run fails fast with a clear message before touching the plan, ports, or Docker at
// all. See run-lock.ts; released in global-teardown.ts (and, if globalSetup itself throws before
// teardown ever runs, in global-setup.ts's own catch block).
acquireRunLock()

// Computed once, here, before `webServer` below is built - see plan.ts's doc comment for why this
// has to happen at config-eval time rather than inside globalSetup.
const plan = await resolveAndPersistE2ePlan()

function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

const backendEnv = normalizeEnv({
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(plan.backendPort),
  // Runtime creds, like production (backend/README.md, "Runtime DB role") - global-setup.ts
  // activates `backend_runtime` with this exact password before any test issues a request that
  // actually needs the database; MIGRATE_DATABASE_URL stays on the superuser connection so
  // `prisma migrate deploy` (also run from global-setup.ts) keeps working.
  DATABASE_URL: plan.runtimeDatabaseUrl,
  MIGRATE_DATABASE_URL: plan.superuserDatabaseUrl,
  SUPABASE_URL: plan.supabaseUrl,
  SUPABASE_JWT_SECRET: plan.jwtSecret,
  CORS_ORIGINS: plan.webUrl,
  ADMIN_USERS_READ_RATE_LIMIT_MAX: process.env.E2E_ADMIN_USERS_READ_RATE_LIMIT_MAX ?? '240',
})

const webEnv = normalizeEnv({
  ...process.env,
  VITE_SUPABASE_URL: plan.supabaseUrl,
  VITE_SUPABASE_ANON_KEY: plan.anonKey,
  VITE_API_URL: plan.backendUrl,
})

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  testDir: './e2e/specs',
  outputDir: './e2e/.artifacts/test-results',
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/.artifacts/report' }]],
  use: {
    baseURL: plan.webUrl,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      name: 'backend',
      command: 'bun run start',
      cwd: backendRoot,
      env: backendEnv,
      // Liveness, not readiness (backend/src/app.ts): this must succeed before global-setup.ts has
      // migrated the e2e database or activated backend_runtime, so it cannot depend on the
      // database being reachable yet.
      url: `${plan.backendUrl}/health/live`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      name: 'web',
      command: `bun run dev --host 127.0.0.1 --port ${plan.webPort}`,
      cwd: frontendRoot,
      env: webEnv,
      url: plan.webUrl,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
