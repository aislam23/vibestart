import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

import { composeArgs, planFilePath, repositoryRoot, scratchSupabaseEnvPath } from './env'
import { composeEnv, readE2ePlan } from './plan'
import { releaseRunLock } from './run-lock'

export default function globalTeardown() {
  const keepDocker = process.env.E2E_KEEP_DOCKER === '1'
  const keepScratchFilesEnv = process.env.E2E_KEEP_SCRATCH_FILES

  // Keeping the stack up with no way to reattach to it is worse than either keeping both or
  // deleting both: a later run would call `resolveAndPersistE2ePlan()` (plan.ts), find no
  // plan.json, and generate a brand-new set of ports/secrets/scratch `.env` that has nothing to do
  // with the containers still running under the old ones - silently orphaning them (and likely
  // colliding on the fixed `vibestart-e2e` project/container names once it tries to start its own).
  // So `E2E_KEEP_DOCKER=1` always implies keeping the scratch files too; only reject the
  // explicitly-contradictory combination (`E2E_KEEP_SCRATCH_FILES` set to anything other than
  // `1` while `E2E_KEEP_DOCKER=1`) rather than silently overriding the user's own flag.
  if (keepDocker && keepScratchFilesEnv !== undefined && keepScratchFilesEnv !== '1') {
    throw new Error(
      'E2E_KEEP_DOCKER=1 requires keeping the scratch plan.json/supabase.env too, so a future run ' +
        'can reattach to the still-running stack instead of generating new ports/secrets that no ' +
        'longer match it. Unset E2E_KEEP_SCRATCH_FILES (it is implied) or set it to 1 - do not set ' +
        'it to anything else together with E2E_KEEP_DOCKER=1.',
    )
  }
  const keepScratchFiles = keepDocker || keepScratchFilesEnv === '1'

  try {
    if (!keepDocker) {
      const plan = readE2ePlan()
      // `-v` is correct here, and only here: `vibestart-e2e` is a throwaway project this
      // orchestrator creates fresh every run (global-setup.ts) against its own named volumes
      // (project-prefixed via `-p`, so this never touches the dev stack's `supabase_db-data` etc.) -
      // never the developer's own dev Supabase stack (project `supabase`, infra/supabase/.env).
      //
      // `composeEnv(plan)`, not an inherited `process.env` - see plan.ts's `composeEnv` doc
      // comment for why every `docker compose` invocation in this orchestrator uses it.
      const result = spawnSync('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], {
        cwd: repositoryRoot,
        stdio: 'inherit',
        env: composeEnv(plan),
      })
      if (result.status !== 0) {
        throw new Error(`Command failed: docker compose -p vibestart-e2e down -v --remove-orphans`)
      }
    }

    // Scrub the generated secrets (JWT signing key, Postgres password, backend_runtime password,
    // service role key, dashboard password) once the stack they belonged to is gone (or, with
    // E2E_KEEP_DOCKER=1, deliberately left running - see the check above). Deliberately narrow:
    // this does not remove the rest of e2e/.artifacts/ (the HTML report and test-results/
    // traces/screenshots/video playwright.config.ts points there), which are meant to survive the
    // run for inspection.
    if (!keepScratchFiles) {
      rmSync(scratchSupabaseEnvPath, { force: true })
      rmSync(planFilePath, { force: true })
    }
  } finally {
    // Always releases, regardless of the flags above - the lock is about serializing runs, not
    // about the docker/scratch-file debugging affordances those flags control. A run left "kept"
    // for debugging must not also block every subsequent `bun run e2e:webapp` behind its lock.
    releaseRunLock()
  }
}
