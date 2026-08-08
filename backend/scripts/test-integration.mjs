#!/usr/bin/env bun
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

if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test') && !databaseUrl.includes('54329')) {
  // db_test always runs on its own port; this is a last-resort guard against an operator having
  // pointed TEST_DATABASE_URL at a real database by mistake, since `down --volumes` runs no
  // matter how the tests finish.
  throw new Error(`Refusing to run integration tests against a non-test-looking DATABASE_URL: ${databaseUrl}`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? backendRoot,
    env: options.env ?? process.env,
    stdio: 'inherit',
  })

  if (result.status !== 0) process.exit(result.status ?? 1)
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

  console.error('Timed out waiting for db_test to become healthy')
  process.exit(1)
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

const env = { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl }

try {
  run('docker', [...composeArgs, 'up', '-d', 'db_test'])
  await waitForHealthyDbTest()

  run('bun', ['run', 'prisma:generate'], { env })
  run('bun', ['run', 'prisma:deploy'], { env })

  const integrationTestFiles = await findIntegrationTestFiles()
  if (integrationTestFiles.length === 0) {
    console.error('No *.integration.test.ts files found under backend/src')
    process.exit(1)
  }

  run('bun', ['test', ...integrationTestFiles], { env })
} finally {
  // `-v` is deliberately correct here, and only here: db_test is a throwaway fixture container
  // this script owns exclusively, never the dev Supabase stack (infra/supabase).
  spawnSync('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans'], {
    cwd: backendRoot,
    stdio: 'inherit',
  })
}
