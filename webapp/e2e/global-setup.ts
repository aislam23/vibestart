import { spawnSync } from 'node:child_process'

import { composeArgs, e2eAdminEmail, e2eAdminPassword, repositoryRoot } from './env'
import { readE2ePlan, type E2ePlan } from './plan'

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, env, stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`)
  }
}

/** Runs `psql` inside the e2e `db` container. Addressed by compose *service* name ("db"), not the
 * renamed `container_name` from docker-compose.e2e-override.yml - `docker compose exec` resolves
 * the right container from the project + service label pair regardless of what it's named, so
 * this needs no knowledge of that override. `-U supabase_admin` against the local socket relies on
 * the same trust-auth behavior backend/scripts/test-integration.mjs already depends on for its own
 * throwaway Postgres (same base image, supabase/postgres) - and, like that script, uses
 * `supabase_admin` rather than `postgres` because only `supabase_admin` is an actual superuser
 * here (see plan.ts's `superuserDatabaseUrl` comment). */
function psql(sql: string): string {
  const result = spawnSync(
    'docker',
    [...composeArgs, 'exec', '-T', 'db', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres', '-tAc', sql],
    { cwd: repositoryRoot, encoding: 'utf8' },
  )

  if (result.status !== 0) {
    console.error(result.stderr)
    throw new Error(`psql failed: ${sql}`)
  }

  return result.stdout?.trim() ?? ''
}

export default async function globalSetup() {
  const plan = readE2ePlan()

  // db/auth/kong only - see docker-compose.e2e-override.yml's header comment for why the rest of
  // the stack is never started. `--wait` blocks until db (healthcheck) and auth (healthcheck,
  // which GoTrue only reports once its own startup migrations against `auth.*` have completed)
  // are both healthy before kong is considered ready, so the migration step below never races
  // against a Postgres or GoTrue that isn't actually up yet.
  run('docker', [...composeArgs, 'up', '-d', 'db', 'auth', 'kong', '--wait', '--wait-timeout', '120'])

  // `prisma migrate deploy` runs as the Postgres superuser and, among other things, grants
  // `backend_runtime` read access to `auth.users` (see backend/prisma/migrations/*_backend_runtime_role) -
  // it has to run after `auth` is healthy so that table already exists.
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
  psql(`ALTER ROLE backend_runtime LOGIN PASSWORD '${plan.backendRuntimePassword}';`)

  await seedAdmin(plan)
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

  psql(`UPDATE profiles SET role = 'admin' WHERE id = '${adminId}';`)
}
