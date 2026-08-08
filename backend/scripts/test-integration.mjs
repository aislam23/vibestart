#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const composeArgs = ['compose', '-f', 'docker-compose.test.yml']
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://supabase_admin:test-throwaway-password@127.0.0.1:54329/postgres?schema=public'

assertSafeIntegrationDatabaseUrl(databaseUrl)

/**
 * `db_test` has one fixed shape (backend/docker-compose.test.yml): loopback host, port 54329,
 * database "postgres". Checking that with a substring test (`.includes('54329')`, the previous
 * guard) is bypassable by anything that merely contains that digit string - a query parameter, a
 * path segment, a comment. Parsing the URL and comparing its actual host/port/database closes that
 * gap. `DESTRUCTIVE_TEST_ACK=yes` exists for a deliberately different db_test shape (a non-default
 * port, say) - it never allows a non-loopback host, because this script's teardown runs
 * `docker compose down --volumes` unconditionally otherwise.
 */
function assertSafeIntegrationDatabaseUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`TEST_DATABASE_URL is not a valid URL: ${rawUrl}`)
  }

  const isLoopbackHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  const isDbTestShape = isLoopbackHost && parsed.port === '54329' && parsed.pathname === '/postgres'
  if (isDbTestShape) return

  const ackOverride = process.env.DESTRUCTIVE_TEST_ACK === 'yes'
  if (ackOverride && isLoopbackHost) return

  throw new Error(
    `Refusing to run destructive integration tests against ${rawUrl}: expected a loopback host ` +
      '(127.0.0.1 or localhost), port 54329, and database "postgres" - db_test\'s fixed shape ' +
      '(backend/docker-compose.test.yml). Set DESTRUCTIVE_TEST_ACK=yes together with a loopback ' +
      'TEST_DATABASE_URL to override deliberately.',
  )
}

class RunFailure extends Error {
  constructor(command, exitCode) {
    super(`${command} failed with exit code ${exitCode}`)
    this.exitCode = exitCode
  }
}

// Throws instead of calling `process.exit()` on failure, unlike the shell-script-style helper this
// replaces: an immediate `process.exit()` skips any pending `finally`, which would have skipped the
// sentinel check and the `docker compose down` teardown below whenever a step failed - exactly the
// failure path most worth cleaning up after.
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? backendRoot,
    env: options.env ?? process.env,
    stdio: 'inherit',
  })

  if (result.status !== 0) throw new RunFailure([command, ...args].join(' '), result.status ?? 1)
}

function psql(sql, { check = true } = {}) {
  const result = spawnSync(
    'docker',
    [...composeArgs, 'exec', '-T', 'db_test', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres', '-tAc', sql],
    { cwd: backendRoot, encoding: 'utf8' },
  )

  if (check && result.status !== 0) {
    console.error(result.stderr)
    throw new RunFailure(`psql: ${sql}`, result.status ?? 1)
  }

  return result
}

async function waitForHealthyDbTest() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = spawnSync(
      'docker',
      [...composeArgs, 'exec', '-T', 'db_test', 'pg_isready', '-U', 'supabase_admin', '-d', 'postgres'],
      { cwd: backendRoot, stdio: 'ignore' },
    )

    if (result.status === 0) return

    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
  }

  throw new Error('Timed out waiting for db_test to become healthy')
}

// Proves that the `db_test` container this run tears down (with `docker compose down --volumes`,
// the one destructive step in this script) is the same one it created and migrated, not some other
// container that happens to answer on the same loopback port. Created after the database is
// healthy but before migrations or the test suite run, and checked again right before teardown.
//
// Lives in its own schema, not `public`: creating it there before `prisma migrate deploy` would
// make Prisma see a "non-empty" `public` schema on a database it has never touched and refuse to
// deploy (P3005, "baseline an existing database").
const sentinelMarker = `vibestart-backend-test:${process.pid}:${randomUUID()}`

function createSentinel() {
  psql(
    'CREATE SCHEMA IF NOT EXISTS _vibestart_test; ' +
      'CREATE TABLE IF NOT EXISTS _vibestart_test.sentinel (marker text NOT NULL); ' +
      `DELETE FROM _vibestart_test.sentinel; INSERT INTO _vibestart_test.sentinel (marker) VALUES ('${sentinelMarker}');`,
  )
}

function verifySentinelBeforeTeardown() {
  const result = psql('SELECT marker FROM _vibestart_test.sentinel LIMIT 1;', { check: false })
  const marker = result.stdout?.trim()

  if (result.status !== 0 || marker !== sentinelMarker) {
    console.error(
      'Refusing to run the destructive `docker compose down --volumes` teardown: the sentinel ' +
        `check failed (expected "${sentinelMarker}", got "${marker || '<none>'}"). This db_test ` +
        'container may not be the one this run created; leaving it up for manual inspection.',
    )
    return false
  }

  return true
}

/**
 * Activates the least-privileged runtime role the backend_runtime_role migration creates
 * (NOLOGIN until an operator opts in - see backend/README.md, "Runtime DB role"), as the test
 * fixture's own one-time superuser step, then returns a connection string for it so the app-facing
 * integration tests exercise the same privilege boundary production does instead of running as the
 * migration superuser.
 */
function activateBackendRuntimeRole(superuserDatabaseUrl) {
  const password = randomUUID()
  psql(`ALTER ROLE backend_runtime LOGIN PASSWORD '${password}';`)

  const url = new URL(superuserDatabaseUrl)
  url.username = 'backend_runtime'
  url.password = password
  return url.toString()
}

async function findIntegrationTestFiles() {
  const srcRoot = path.join(backendRoot, 'src')
  const files = []

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
      } else if (entry.name.endsWith('.integration.test.ts')) {
        files.push(path.relative(backendRoot, entryPath))
      }
    }
  }

  await walk(srcRoot)
  return files.sort()
}

async function runIntegrationSuite() {
  run('docker', [...composeArgs, 'up', '-d', 'db_test'])
  await waitForHealthyDbTest()
  createSentinel()

  // Migrations run as the superuser (`MIGRATE_DATABASE_URL`, falling back to `DATABASE_URL` - see
  // prisma.config.ts); the app-facing test client runs as `backend_runtime`
  // (`TEST_RUNTIME_DATABASE_URL`, activated below) - the same split production uses once an
  // operator activates the role.
  const migrateEnv = { ...process.env, DATABASE_URL: databaseUrl, MIGRATE_DATABASE_URL: databaseUrl }
  run('bun', ['run', 'prisma:generate'], { env: migrateEnv })
  run('bun', ['run', 'prisma:deploy'], { env: migrateEnv })

  const runtimeDatabaseUrl = activateBackendRuntimeRole(databaseUrl)

  const integrationTestFiles = await findIntegrationTestFiles()
  if (integrationTestFiles.length === 0) {
    throw new Error('No *.integration.test.ts files found under backend/src')
  }

  const testEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    TEST_RUNTIME_DATABASE_URL: runtimeDatabaseUrl,
  }
  run('bun', ['test', ...integrationTestFiles], { env: testEnv })
}

let exitCode = 0
try {
  try {
    await runIntegrationSuite()
  } finally {
    // `-v` is deliberately correct here, and only here: db_test is a throwaway fixture container
    // this script owns exclusively, never the dev Supabase stack (infra/supabase). Skipped
    // entirely if the sentinel check fails, rather than risk deleting volumes that belong to
    // something else.
    if (verifySentinelBeforeTeardown()) {
      spawnSync('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans'], {
        cwd: backendRoot,
        stdio: 'inherit',
      })
    } else {
      exitCode = 1
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  exitCode = (error instanceof RunFailure ? error.exitCode : 1) || 1
}

process.exitCode = exitCode
