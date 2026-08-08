#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const repositoryRoot = resolve(backendRoot, '..')
const composeArgs = ['compose', '-f', 'docker-compose.test.yml']
// Fixed by backend/docker-compose.test.yml's `name:` field - see there for why this is safe to
// hardcode rather than ask Docker for it.
const networkName = 'vibestart-backend-test_default'

const imageName = process.env.BACKEND_DOCKER_SMOKE_IMAGE ?? 'vibestart-backend:smoke'
const containerName = process.env.BACKEND_DOCKER_SMOKE_CONTAINER ?? `vibestart-backend-smoke-${process.pid}`
const hostPort = process.env.BACKEND_DOCKER_SMOKE_PORT ?? String(await findOpenPort())
const databaseUrlForHost =
  process.env.TEST_DATABASE_URL ?? 'postgresql://supabase_admin:test-throwaway-password@127.0.0.1:54329/postgres?schema=public'
// `db_test` is the service's name on the compose network above - resolvable from inside the
// smoke container, unlike the host-mapped 127.0.0.1:54329 used to run migrations from the host.
const databaseUrlForContainer = 'postgresql://supabase_admin:test-throwaway-password@db_test:5432/postgres?schema=public'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}`)
  }
}

function findOpenPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()

    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') {
          resolvePort(address.port)
          return
        }

        reject(new Error('Could not allocate an open TCP port'))
      })
    })
  })
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

  process.stderr.write('Timed out waiting for db_test\n')
  throw new Error('Timed out waiting for db_test')
}

async function waitForHealth() {
  const url = `http://127.0.0.1:${hostPort}/health/ready`

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        process.stdout.write(`Backend Docker smoke passed: ${url}\n`)
        return
      }
    } catch {
      // Retry until the container finishes booting.
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
  }

  process.stderr.write(`Timed out waiting for ${url}\n`)
  spawnSync('docker', ['logs', containerName], { stdio: 'inherit' })
  throw new Error(`Timed out waiting for ${url}`)
}

async function waitForDockerHealthy() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = spawnSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', containerName], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    if (result.status === 0 && result.stdout.toString().trim() === 'healthy') {
      process.stdout.write(`Backend Docker smoke: container healthcheck reports healthy (${containerName})\n`)
      return
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
  }

  process.stderr.write(`Timed out waiting for ${containerName}'s Docker healthcheck to report healthy\n`)
  spawnSync('docker', ['inspect', '--format', '{{json .State.Health}}', containerName], { stdio: 'inherit' })
  throw new Error(`Timed out waiting for ${containerName}'s Docker healthcheck`)
}

try {
  run('docker', [...composeArgs, 'up', '-d', 'db_test'], { cwd: backendRoot })
  await waitForHealthyDbTest()

  run('bun', ['run', '--cwd', 'backend', 'prisma:deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrlForHost },
  })

  run('docker', ['build', '-f', 'backend/Dockerfile', '-t', imageName, '.'])
  spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' })

  run('docker', [
    'run',
    '-d',
    '--name',
    containerName,
    '--network',
    networkName,
    '-p',
    `127.0.0.1:${hostPort}:3000`,
    // Mirrors infra/app/docker-compose.yml's production constraints on `backend`, so this smoke
    // test exercises the actual container contract (read-only rootfs, no privilege escalation,
    // non-root user, the exact compose healthcheck command, matching stop-timeout) - not just
    // "the image boots" under a permissive `docker run`.
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--security-opt',
    'no-new-privileges:true',
    '--user',
    'bun',
    '--stop-timeout',
    '30',
    '--health-cmd',
    "bun -e \"fetch('http://127.0.0.1:3000/health/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\"",
    '--health-interval',
    '10s',
    '--health-timeout',
    '5s',
    '--health-retries',
    '5',
    '--health-start-period',
    '15s',
    '-e',
    'PORT=3000',
    '-e',
    `DATABASE_URL=${databaseUrlForContainer}`,
    '-e',
    'SUPABASE_URL=https://supabase.example.com',
    // NODE_ENV=production (set in the Dockerfile) requires a non-placeholder 32+ char secret and
    // HTTPS-only CORS origins - see backend/src/env.ts.
    '-e',
    `SUPABASE_JWT_SECRET=${randomHexSecret()}`,
    '-e',
    'CORS_ORIGINS=https://web.example.com',
    imageName,
  ])

  await waitForHealth()
  await waitForDockerHealthy()
} finally {
  spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' })
  spawnSync('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans'], {
    cwd: backendRoot,
    stdio: 'inherit',
  })
}

function randomHexSecret() {
  return Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}
