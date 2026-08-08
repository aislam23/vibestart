import { spawnSync } from 'node:child_process'

import { composeArgs, repositoryRoot } from './env'
import { composeEnv, type E2ePlan } from './plan'

/**
 * Runs `psql` inside the e2e `db` container. Addressed by compose *service* name ("db"), not the
 * renamed `container_name` from docker-compose.e2e-override.yml - `docker compose exec` resolves
 * the right container from the project + service label pair regardless of what it's named, so this
 * needs no knowledge of that override. `-U supabase_admin` against the local socket relies on the
 * same trust-auth behavior backend/scripts/test-integration.mjs already depends on for its own
 * throwaway Postgres (same base image, supabase/postgres) - and, like that script, uses
 * `supabase_admin` rather than `postgres` because only `supabase_admin` is an actual superuser here
 * (see plan.ts's `superuserDatabaseUrl` comment).
 *
 * Shared by global-setup.ts (seeding the e2e administrator) and any spec that needs to read
 * something out of the throwaway database directly - e.g. auth.spec.ts's recovery-link test reads
 * `auth.users.recovery_token` because there is no SMTP/mailbox in e2e to read the link out of
 * instead.
 */
export function psql(plan: E2ePlan, sql: string): string {
  const result = spawnSync(
    'docker',
    [...composeArgs, 'exec', '-T', 'db', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres', '-tAc', sql],
    { cwd: repositoryRoot, encoding: 'utf8', env: composeEnv(plan) },
  )

  if (result.status !== 0) {
    console.error(result.stderr)
    throw new Error(`psql failed: ${sql}`)
  }

  return result.stdout?.trim() ?? ''
}
