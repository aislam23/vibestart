import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const webappRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
export const repositoryRoot = resolve(webappRoot, '..')
export const backendRoot = resolve(repositoryRoot, 'backend')
export const supabaseRoot = resolve(repositoryRoot, 'infra/supabase')

// A fixed, non-hashed project name: this is a single-checkout template, and the whole point of
// this name is that it is easy to recognize and `docker compose -p vibestart-e2e down -v` by hand
// if a run is ever interrupted before global-teardown.ts gets to run.
export const composeProjectName = 'vibestart-e2e'

export const artifactsDir = resolve(webappRoot, 'e2e/.artifacts')
// Scratch, throwaway secrets - never infra/supabase/.env (see webapp/README.md, "E2E"). Removed
// by global-teardown.ts at the end of every run.
export const scratchSupabaseEnvPath = resolve(artifactsDir, 'supabase.env')
export const planFilePath = resolve(artifactsDir, 'plan.json')

// `-f infra/supabase/docker-compose.yml -f e2e/docker-compose.e2e-override.yml`: the override
// renames the handful of services e2e brings up (see that file's header comment for why) and
// isolates the `supabase` network name so this project can run alongside the developer's own dev
// stack (project `supabase`) on the same Docker host without colliding.
//
// `--env-file` is not optional here: without it, `docker compose` falls back to reading a plain
// `.env` from the project directory (the directory of the first `-f` file, i.e. `infra/supabase/`)
// - which is exactly `infra/supabase/.env`, the dev stack's real secrets, if that file happens to
// exist on this machine. Pointing `--env-file` at the scratch file explicitly is what actually
// keeps this throwaway stack's ports/passwords/keys isolated from dev, not just the container
// name and network overrides above.
export const composeArgs = [
  'compose',
  '-p',
  composeProjectName,
  '-f',
  resolve(supabaseRoot, 'docker-compose.yml'),
  '-f',
  resolve(webappRoot, 'e2e/docker-compose.e2e-override.yml'),
  '--env-file',
  scratchSupabaseEnvPath,
]

// Preferred ports, distinct from both the dev Supabase stack (infra/supabase/.env.example:
// KONG_HTTP_PORT=54321, POSTGRES_PORT=54322) and the backend's own throwaway integration-test
// Postgres (backend/docker-compose.test.yml: 54329). ports.ts scans forward from these if they are
// occupied, so a second concurrent run (or a leftover process) never blocks this one.
export const preferredKongPort = 54341
export const preferredPostgresPort = 54342
export const preferredBackendPort = 54210
export const preferredWebPort = 54110

// Seeded once per run by global-setup.ts (see its "seed the e2e administrator" step). Not a
// secret worth randomizing: this account only ever exists inside a throwaway, `-v`-torn-down
// database that never leaves this host.
export const e2eAdminEmail = 'admin@vibestart-e2e.test'
export const e2eAdminPassword = 'vibestart-e2e-admin-password'
