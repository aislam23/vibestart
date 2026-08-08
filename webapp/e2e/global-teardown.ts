import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

import { composeArgs, planFilePath, repositoryRoot, scratchSupabaseEnvPath } from './env'

export default function globalTeardown() {
  if (process.env.E2E_KEEP_DOCKER !== '1') {
    // `-v` is correct here, and only here: `vibestart-e2e` is a throwaway project this
    // orchestrator creates fresh every run (global-setup.ts) against its own named volumes
    // (project-prefixed via `-p`, so this never touches the dev stack's `supabase_db-data` etc.) -
    // never the developer's own dev Supabase stack (project `supabase`, infra/supabase/.env).
    const result = spawnSync('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], {
      cwd: repositoryRoot,
      stdio: 'inherit',
    })
    if (result.status !== 0) {
      throw new Error(`Command failed: docker compose -p vibestart-e2e down -v --remove-orphans`)
    }
  }

  // Scrub the generated secrets (JWT signing key, Postgres password, backend_runtime password)
  // once the stack they belonged to is gone. Deliberately narrow: this does not remove the rest of
  // e2e/.artifacts/ (the HTML report and test-results/ traces/screenshots/video playwright.config.ts
  // points there), which are meant to survive the run for inspection.
  if (process.env.E2E_KEEP_SCRATCH_FILES !== '1') {
    rmSync(scratchSupabaseEnvPath, { force: true })
    rmSync(planFilePath, { force: true })
  }
}
