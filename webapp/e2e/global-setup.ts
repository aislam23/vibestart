import { spawnSync } from 'node:child_process'

import { composeArgs, e2eAdminEmail, e2eAdminPassword, repositoryRoot } from './env'
import { psql } from './db'
import { composeEnv, readE2ePlan, type E2ePlan } from './plan'
import { releaseRunLock } from './run-lock'

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, env, stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`)
  }
}

export default async function globalSetup() {
  // The lock itself is acquired in playwright.config.ts (before this even runs - see that file's
  // comment for why). If anything below throws, globalTeardown never runs (Playwright's contract:
  // it only runs after a successful globalSetup) - so this is the one place responsible for
  // releasing the lock on a globalSetup-stage failure; every other path is global-teardown.ts's job.
  try {
    const plan = readE2ePlan()

    // db/auth/kong only - see docker-compose.e2e-override.yml's header comment for why the rest of
    // the stack is never started. `--wait` blocks until db (healthcheck) and auth (healthcheck,
    // which GoTrue only reports once its own startup migrations against `auth.*` have completed)
    // are both healthy before kong is considered ready, so the migration step below never races
    // against a Postgres or GoTrue that isn't actually up yet.
    //
    // `composeEnv(plan)`, not an inherited `process.env`: this is the one place a poisoned/
    // leftover host-shell POSTGRES_PASSWORD/JWT_SECRET/etc. could otherwise silently override the
    // scratch secrets `--env-file` already supplies - see plan.ts's `composeEnv` doc comment.
    run(
      'docker',
      [...composeArgs, 'up', '-d', 'db', 'auth', 'kong', '--wait', '--wait-timeout', '120'],
      composeEnv(plan),
    )

    // `prisma migrate deploy` runs as the Postgres superuser and, among other things, grants
    // `backend_runtime` read access to `auth.users` (see backend/prisma/migrations/*_backend_runtime_role) -
    // it has to run after `auth` is healthy so that table already exists. Not a `docker compose`
    // invocation - this is `bun run` talking to Postgres over its published loopback port, so it
    // legitimately inherits `process.env` (e.g. PATH to `bun`) with just these two keys overridden.
    const migrateEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: plan.superuserDatabaseUrl,
      MIGRATE_DATABASE_URL: plan.superuserDatabaseUrl,
    }
    run('bun', ['run', '--cwd', 'backend', 'prisma:generate'], migrateEnv)
    run('bun', ['run', '--cwd', 'backend', 'prisma:deploy'], migrateEnv)

    // Activates the least-privileged runtime role the migration above created NOLOGIN (see
    // backend/README.md, "Runtime DB role") with the exact password playwright.config.ts already
    // baked into the backend webServer's DATABASE_URL - see plan.ts for why both read that value
    // from the same persisted plan instead of generating it twice.
    psql(plan, `ALTER ROLE backend_runtime LOGIN PASSWORD '${plan.backendRuntimePassword}';`)

    await seedAdmin(plan)
  } catch (error) {
    // Nothing to hand off to teardown (which never runs if globalSetup throws) - release the lock
    // ourselves so a failed run doesn't block every subsequent one behind a stale lock.
    releaseRunLock()
    throw error
  }
}

/** Seeds the one administrator rbac.spec.ts needs. Signs up directly against GoTrue (bypassing
 * the webapp UI, so global setup doesn't depend on the frontend being reachable yet), hits the
 * backend once as that user to provision its `profiles` row (backend/README.md, "How auth works" -
 * the row is created lazily on the first authenticated request, there is no separate
 * "create a user" step), then promotes it with SQL: there is no admin-creation API by design
 * (backend/README.md, "Recovery" describes the same manual `UPDATE profiles` for the equivalent
 * production recovery case). */
async function seedAdmin(plan: E2ePlan) {
  const signupResponse = await fetch(`${plan.supabaseUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: plan.anonKey },
    body: JSON.stringify({ email: e2eAdminEmail, password: e2eAdminPassword }),
  })
  if (!signupResponse.ok) {
    throw new Error(`Failed to seed e2e admin (GoTrue signup): ${signupResponse.status} ${await signupResponse.text()}`)
  }

  const signupBody = (await signupResponse.json()) as { access_token?: string; user?: { id?: string } }
  const accessToken = signupBody.access_token
  const adminId = signupBody.user?.id
  if (!accessToken || !adminId) {
    throw new Error(`Unexpected GoTrue signup response while seeding e2e admin: ${JSON.stringify(signupBody)}`)
  }

  const meResponse = await fetch(`${plan.backendUrl}/api/users/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!meResponse.ok) {
    throw new Error(`Failed to provision e2e admin profile: ${meResponse.status} ${await meResponse.text()}`)
  }

  psql(plan, `UPDATE profiles SET role = 'admin' WHERE id = '${adminId}';`)
}
