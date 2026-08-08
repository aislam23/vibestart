import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { SignJWT } from 'jose'

import { createApp } from '../../app'
import { createPrisma } from '../../db'
import { loadEnv, type AppEnv } from '../../env'
import { createAdminUsersRepository } from './infrastructure/admin-users-repository'

/**
 * Runs against the real `db_test` Postgres container (see backend/docker-compose.test.yml),
 * started, migrated, and role-activated by `bun run test:integration`
 * (backend/scripts/test-integration.mjs). Skipped entirely under plain `bun test`, which is what
 * `bun run test` (unit only) uses.
 */
const databaseUrl = process.env.TEST_DATABASE_URL
const runtimeDatabaseUrl = process.env.TEST_RUNTIME_DATABASE_URL
const maybeDescribe = databaseUrl && runtimeDatabaseUrl ? describe : describe.skip
// `describe.skip` still calls this function to discover the nested tests it is skipping, so
// `loadEnv`/`createPrisma` below must never throw or connect when there is no real database - a
// placeholder keeps them harmless when the env vars above are unset (plain `bun test`).
const effectiveDatabaseUrl = databaseUrl ?? 'postgresql://supabase_admin:postgres@localhost:5432/postgres'
const effectiveRuntimeDatabaseUrl = runtimeDatabaseUrl ?? effectiveDatabaseUrl

const supabaseJwtSecret = '12345678901234567890123456789012'

maybeDescribe('users and admin API integration', () => {
  const env: AppEnv = loadEnv({
    DATABASE_URL: effectiveDatabaseUrl,
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_JWT_SECRET: supabaseJwtSecret,
    CORS_ORIGINS: 'http://localhost:5173',
    // High enough that no test other than the dedicated rate-limit test below - which builds its
    // own app with a much lower budget - ever hits it by accident.
    ADMIN_USERS_READ_RATE_LIMIT_MAX: '50',
    ADMIN_USERS_READ_RATE_LIMIT_WINDOW_SECONDS: '60',
  })
  // Fixture setup/teardown and assertions run as the migration superuser - inserting into
  // `auth.users` (a GoTrue-owned table the backend never writes to) needs privileges the app
  // itself must not have. The app under test, `app` below, is wired to `appPrisma` instead: the
  // least-privileged `backend_runtime` role (see the backend_runtime_role migration and
  // backend/README.md's "Runtime DB role"), so these tests exercise the same privilege boundary
  // production does, not the migration superuser's.
  const superuserPrisma = createPrisma(effectiveDatabaseUrl)
  const appPrisma = createPrisma(effectiveRuntimeDatabaseUrl)
  const app = createApp({ env, prisma: appPrisma })

  beforeEach(async () => {
    await superuserPrisma.profile.deleteMany()
    await superuserPrisma.$executeRaw`DELETE FROM auth.users`
  })

  afterAll(async () => {
    await superuserPrisma.$disconnect()
    await appPrisma.$disconnect()
  })

  test('provisions a profile on first sight of a token, and a concurrent double request does not crash', async () => {
    const userId = randomUUID()
    await insertAuthUser(userId, 'race@example.com')
    const token = await signToken(userId, 'race@example.com', { displayName: 'Racer' })

    // Both requests race to provision the same brand-new profile; `ensureProfile`'s P2002 handling
    // (backend/src/modules/auth-context/profile-repository.ts) must let both succeed with the
    // same result instead of one of them crashing.
    const [first, second] = await Promise.all([
      app.request('/api/users/me', { headers: authHeaders(token) }),
      app.request('/api/users/me', { headers: authHeaders(token) }),
    ])
    const [firstBody, secondBody] = (await Promise.all([first.json(), second.json()])) as [
      { user: Record<string, unknown> },
      { user: Record<string, unknown> },
    ]

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(firstBody.user).toMatchObject({ id: userId, email: 'race@example.com', displayName: 'Racer', role: 'user' })
    expect(secondBody.user).toEqual(firstBody.user)
    expect(await superuserPrisma.profile.count({ where: { id: userId } })).toBe(1)
  })

  test('GET and PATCH /api/users/me round-trip against real Postgres', async () => {
    const userId = randomUUID()
    await insertAuthUser(userId, 'profile@example.com')
    const token = await signToken(userId, 'profile@example.com')

    const me = await app.request('/api/users/me', { headers: authHeaders(token) })
    expect(me.status).toBe(200)
    expect((await me.json()).user).toMatchObject({ role: 'user', displayName: null })

    const update = await app.request('/api/users/me', {
      method: 'PATCH',
      headers: jsonHeaders(token),
      body: JSON.stringify({ displayName: '  Updated Name  ' }),
    })
    expect(update.status).toBe(200)
    expect((await update.json()).user.displayName).toBe('Updated Name')

    const clear = await app.request('/api/users/me', {
      method: 'PATCH',
      headers: jsonHeaders(token),
      body: JSON.stringify({ displayName: null }),
    })
    expect(clear.status).toBe(200)
    expect((await clear.json()).user.displayName).toBeNull()

    const invalid = await app.request('/api/users/me', {
      method: 'PATCH',
      headers: jsonHeaders(token),
      body: JSON.stringify({ displayName: 'x' }),
    })
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).error.code).toBe('VALIDATION_ERROR')
  })

  test('the admin directory paginates and filters by email or display name, and is hidden from non-admins', async () => {
    const admin = await provisionUser('admin@example.com', 'Admin')
    await promoteToAdmin(admin.userId)
    const alice = await provisionUser('alice@example.com', 'Alice Example')
    const bob = await provisionUser('bob@example.com', 'Bob Builder')

    const forbidden = await app.request('/api/admin/users', { headers: authHeaders(alice.token) })
    expect(forbidden.status).toBe(403)

    const firstPage = await app.request('/api/admin/users?page=1&pageSize=2', {
      headers: authHeaders(admin.token),
    })
    const firstPageBody = await firstPage.json()
    expect(firstPage.status).toBe(200)
    expect(firstPageBody).toMatchObject({ page: 1, pageSize: 2, total: 3, hasNext: true })
    expect(firstPageBody.items).toHaveLength(2)

    const secondPage = await app.request('/api/admin/users?page=2&pageSize=2', {
      headers: authHeaders(admin.token),
    })
    const secondPageBody = await secondPage.json()
    expect(secondPageBody).toMatchObject({ page: 2, total: 3, hasNext: false })
    expect(secondPageBody.items).toHaveLength(1)

    const byEmail = await app.request('/api/admin/users?q=alice@example.com', {
      headers: authHeaders(admin.token),
    })
    const byEmailBody = await byEmail.json()
    expect(byEmailBody.items).toEqual([
      expect.objectContaining({ id: alice.userId, email: 'alice@example.com' }),
    ])

    const byDisplayName = await app.request('/api/admin/users?q=builder', {
      headers: authHeaders(admin.token),
    })
    const byDisplayNameBody = await byDisplayName.json()
    expect(byDisplayNameBody.items).toEqual([
      expect.objectContaining({ id: bob.userId, displayName: 'Bob Builder' }),
    ])
  })

  test('rejects self-demotion with a conflict', async () => {
    const admin = await provisionUser('solo-admin@example.com')
    await promoteToAdmin(admin.userId)

    const response = await app.request(`/api/admin/users/${admin.userId}/role`, {
      method: 'PATCH',
      headers: jsonHeaders(admin.token),
      body: JSON.stringify({ role: 'user' }),
    })

    expect(response.status).toBe(409)
    expect((await response.json()).error.message).toContain('cannot remove your own')
    expect(await superuserPrisma.profile.findUniqueOrThrow({ where: { id: admin.userId } })).toMatchObject({
      role: 'admin',
    })
  })

  test('promotes a regular user, applying the new role on their very next request with no session revocation', async () => {
    const admin = await provisionUser('promoter@example.com')
    await promoteToAdmin(admin.userId)
    const target = await provisionUser('promotee@example.com')

    const promote = await app.request(`/api/admin/users/${target.userId}/role`, {
      method: 'PATCH',
      headers: jsonHeaders(admin.token),
      body: JSON.stringify({ role: 'admin' }),
    })
    expect(promote.status).toBe(200)
    expect((await promote.json()).user.role).toBe('admin')

    // No session revocation on a role change (see backend/README.md): the *same* pre-existing
    // token, never reissued, already sees the new role because it is read from `profiles` fresh on
    // every request.
    const me = await app.request('/api/users/me', { headers: authHeaders(target.token) })
    expect(me.status).toBe(200)
    expect((await me.json()).user.role).toBe('admin')

    const idempotent = await app.request(`/api/admin/users/${target.userId}/role`, {
      method: 'PATCH',
      headers: jsonHeaders(admin.token),
      body: JSON.stringify({ role: 'admin' }),
    })
    expect(idempotent.status).toBe(200)
  })

  test('serializes a concurrent cross-demotion between the last two admins, keeping exactly one', async () => {
    const first = await provisionUser('first-admin@example.com')
    const second = await provisionUser('second-admin@example.com')
    await promoteToAdmin(first.userId)
    await promoteToAdmin(second.userId)

    const demote = (actorToken: string, targetId: string) =>
      app.request(`/api/admin/users/${targetId}/role`, {
        method: 'PATCH',
        headers: jsonHeaders(actorToken),
        body: JSON.stringify({ role: 'user' }),
      })

    const [firstDemotesSecond, secondDemotesFirst] = await Promise.all([
      demote(first.token, second.userId),
      demote(second.token, first.userId),
    ])

    // The winner's transaction commits first and demotes its target to `user`. The loser's
    // transaction, queued behind the advisory lock, then re-authorizes *itself* as the actor
    // before touching anything (the fix under test): by the time it is its turn, the winner has
    // already demoted it, so it is no longer an admin at all - 403, not the last-admin invariant's
    // 409. (Before that re-authorization existed, the loser's stale, already-authorized principal
    // would have reached the last-admin check and gotten 409 instead - a strictly weaker
    // guarantee, since it never actually re-confirmed the loser was still allowed to be here.)
    const statuses = [firstDemotesSecond.status, secondDemotesFirst.status].sort()
    expect(statuses).toEqual([200, 403])
    expect(await superuserPrisma.profile.count({ where: { role: 'admin' } })).toBe(1)

    const loser = firstDemotesSecond.status === 403 ? firstDemotesSecond : secondDemotesFirst
    expect((await loser.json()).error.message).toContain('Administrator access is required')
  })

  test('rejects a role change for an unknown user with 404', async () => {
    const admin = await provisionUser('lookup-admin@example.com')
    await promoteToAdmin(admin.userId)

    const response = await app.request(`/api/admin/users/${randomUUID()}/role`, {
      method: 'PATCH',
      headers: jsonHeaders(admin.token),
      body: JSON.stringify({ role: 'admin' }),
    })

    expect(response.status).toBe(404)
  })

  test('re-authorizes the actor inside the lock: a request already past middleware fails after a concurrent demotion commits first', async () => {
    const superAdmin = await provisionUser('super-admin@example.com')
    await promoteToAdmin(superAdmin.userId)
    const aboutToBeDemoted = await provisionUser('about-to-be-demoted@example.com')
    await promoteToAdmin(aboutToBeDemoted.userId)
    const target = await provisionUser('race-target@example.com')

    // `superAdmin` demotes `aboutToBeDemoted` for real - the request that wins the race and
    // commits first.
    const demote = await app.request(`/api/admin/users/${aboutToBeDemoted.userId}/role`, {
      method: 'PATCH',
      headers: jsonHeaders(superAdmin.token),
      body: JSON.stringify({ role: 'user' }),
    })
    expect(demote.status).toBe(200)

    // `aboutToBeDemoted`'s own request already passed `requireAuth`/`requireAdmin` - its principal
    // was loaded before the demotion above committed - and only now reaches the repository: this
    // is exactly what a request queued behind the advisory lock during the race would do.
    // Called directly (below the HTTP layer, which would already reject a *new* request) to
    // reproduce that already-authorized, now-stale in-flight request.
    const adminUsersRepository = createAdminUsersRepository(appPrisma)
    await expect(
      adminUsersRepository.updateRole({
        actorUserId: aboutToBeDemoted.userId,
        targetUserId: target.userId,
        role: 'admin',
      }),
    ).rejects.toThrow('Administrator access is required')

    expect(
      await superuserPrisma.profile.findUniqueOrThrow({ where: { id: target.userId } }),
    ).toMatchObject({ role: 'user' })
  })

  test('counts only active administrators (joined with auth.users) for metrics and the last-admin invariant', async () => {
    const activeAdmin = await provisionUser('active-admin@example.com')
    const orphanedAdmin = await provisionUser('orphaned-admin@example.com')
    await promoteToAdmin(activeAdmin.userId)
    await promoteToAdmin(orphanedAdmin.userId)

    // Simulates GoTrue deleting the auth-side account without the backend mirroring that deletion
    // (see the README's "Recovery" note): the profile row, and its still-valid pre-existing token,
    // survive - orphaned, and invisible to the admin directory's inner join.
    await superuserPrisma.$executeRaw`DELETE FROM auth.users WHERE id = ${orphanedAdmin.userId}::uuid`

    const metrics = await app.request('/api/admin/metrics', { headers: authHeaders(activeAdmin.token) })
    expect(metrics.status).toBe(200)
    expect((await metrics.json()).totalAdmins).toBe(1)

    // A bare `profiles` count would see two administrators (both still `role: admin`) and allow
    // this; only one of them has a reachable account, so it must be blocked.
    const demote = await app.request(`/api/admin/users/${activeAdmin.userId}/role`, {
      method: 'PATCH',
      headers: jsonHeaders(orphanedAdmin.token),
      body: JSON.stringify({ role: 'user' }),
    })
    expect(demote.status).toBe(409)
    expect((await demote.json()).error.message).toContain('At least one administrator must remain')
  })

  test('a role change waits up to its lock_timeout, then fails 409 with Retry-After', async () => {
    const admin = await provisionUser('lock-holder-admin@example.com')
    await promoteToAdmin(admin.userId)
    const target = await provisionUser('lock-target@example.com')

    const release = Promise.withResolvers<void>()
    // Explicit, generous `timeout`: Prisma's own default interactive-transaction timeout is 5s,
    // the same as the `lock_timeout` under test below - without overriding it here, Prisma would
    // race its own timeout against the assertion, sometimes releasing this lock (by rolling this
    // transaction back) just before the request under test hits its own 5s wait.
    const holder = superuserPrisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'users:role-mutation'}))`
        await release.promise
      },
      { timeout: 15_000 },
    )

    // Give the holder a moment to actually acquire the lock before the competing request starts.
    await Bun.sleep(200)

    const startedAt = Date.now()
    const response = await app.request(`/api/admin/users/${target.userId}/role`, {
      method: 'PATCH',
      headers: jsonHeaders(admin.token),
      body: JSON.stringify({ role: 'admin' }),
    })
    const elapsedMs = Date.now() - startedAt

    expect(response.status).toBe(409)
    expect(response.headers.get('retry-after')).toBe('5')
    expect(elapsedMs).toBeGreaterThanOrEqual(4_000)
    expect(elapsedMs).toBeLessThan(8_000)

    release.resolve()
    await holder
  }, 15_000)

  test('rate-limits GET /api/admin/users independently of the rest of the admin API', async () => {
    // A dedicated app with its own tiny budget, so exercising the limit here cannot also exhaust
    // it for the shared `app` other tests in this file use.
    const rateLimitedEnv: AppEnv = { ...env, ADMIN_USERS_READ_RATE_LIMIT_MAX: 2 }
    const rateLimitedApp = createApp({ env: rateLimitedEnv, prisma: appPrisma })
    const admin = await provisionUser('rate-limited-admin@example.com')
    await promoteToAdmin(admin.userId)

    const list = () => rateLimitedApp.request('/api/admin/users', { headers: authHeaders(admin.token) })
    expect((await list()).status).toBe(200)
    expect((await list()).status).toBe(200)
    const limited = await list()
    expect(limited.status).toBe(429)
    expect((await limited.json()).error.code).toBe('RATE_LIMITED')

    // The budget is scoped to the users-directory read - metrics is unaffected.
    const metrics = await rateLimitedApp.request('/api/admin/metrics', { headers: authHeaders(admin.token) })
    expect(metrics.status).toBe(200)
  })

  async function provisionUser(email: string, displayName?: string) {
    const userId = randomUUID()
    await insertAuthUser(userId, email)
    const token = await signToken(userId, email, { displayName })
    const response = await app.request('/api/users/me', { headers: authHeaders(token) })
    expect(response.status).toBe(200)
    return { userId, email, token }
  }

  function promoteToAdmin(userId: string) {
    return superuserPrisma.profile.update({ where: { id: userId }, data: { role: 'admin' } })
  }

  function insertAuthUser(id: string, email: string) {
    return superuserPrisma.$executeRaw`INSERT INTO auth.users (id, email) VALUES (${id}::uuid, ${email})`
  }

  function signToken(userId: string, email: string, { displayName }: { displayName?: string } = {}) {
    return new SignJWT({
      email,
      aud: 'authenticated',
      role: 'authenticated',
      user_metadata: displayName ? { display_name: displayName } : {},
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer(env.SUPABASE_JWT_ISSUER)
      .sign(new TextEncoder().encode(supabaseJwtSecret))
  }
})

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` }
}

function jsonHeaders(token: string) {
  return { ...authHeaders(token), 'Content-Type': 'application/json' }
}
