import { expect, test } from 'bun:test'
import { SignJWT } from 'jose'

import { createApp } from './app'
import type { DbClient } from './db'
import { loadEnv } from './env'

const env = loadEnv({
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:54322/postgres',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_JWT_SECRET: '12345678901234567890123456789012',
})

type FakeProfile = {
  id: string
  role: 'user' | 'admin'
  displayName: string | null
  createdAt: Date
}

function createFakeDb(profiles = new Map<string, FakeProfile>()) {
  const prisma = {
    $queryRaw: async () => [{ '?column?': 1 }],
    profile: {
      findUnique: async ({ where }: { where: { id: string } }) => profiles.get(where.id) ?? null,
      create: async ({ data }: { data: { id: string; displayName: string | null } }) => {
        const record: FakeProfile = {
          id: data.id,
          role: 'user',
          displayName: data.displayName,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        }
        profiles.set(data.id, record)
        return record
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string }
        data: { displayName: string | null }
      }) => {
        const existing = profiles.get(where.id)
        if (!existing) throw Object.assign(new Error('not found'), { code: 'P2025' })
        const updated = { ...existing, ...data }
        profiles.set(where.id, updated)
        return { displayName: updated.displayName }
      },
    },
  }
  return prisma as unknown as DbClient
}

function signSupabaseToken(
  userId: string,
  email: string,
  { secret = env.SUPABASE_JWT_SECRET, role = 'authenticated', aud = 'authenticated' } = {},
) {
  return new SignJWT({ email, aud, role, user_metadata: {} })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret))
}

test('liveness is process-only while readiness checks the database', async () => {
  let databaseAvailable = true
  const prisma = {
    $queryRaw: async () => {
      if (!databaseAvailable) throw new Error('database unavailable')
      return [{ '?column?': 1 }]
    },
  } as unknown as DbClient
  const app = createApp({ env, prisma })

  expect((await app.request('/health/live')).status).toBe(200)
  expect((await app.request('/health/ready')).status).toBe(200)

  databaseAvailable = false

  expect((await app.request('/health/live')).status).toBe(200)
  expect((await app.request('/health/ready')).status).toBe(503)
})

test('CORS preflight allows the standard mutation methods without enabling credentials', async () => {
  const app = createApp({ env, prisma: createFakeDb() })
  const response = await app.request('/api/users/me', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'PATCH',
    },
  })

  expect(response.status).toBe(204)
  expect(response.headers.get('access-control-allow-methods')).toContain('PATCH')
  expect(response.headers.get('access-control-allow-credentials')).toBeNull()
})

test('a disallowed origin is not echoed back', async () => {
  const app = createApp({ env, prisma: createFakeDb() })
  const response = await app.request('/health/live', {
    headers: { Origin: 'https://not-allowed.example.com' },
  })

  expect(response.headers.get('access-control-allow-origin')).toBeNull()
})

test('a valid Supabase access token provisions the profile and returns the current user', async () => {
  const app = createApp({ env, prisma: createFakeDb() })
  const userId = '0196f6f8-6600-7000-8000-000000000001'
  const token = await signSupabaseToken(userId, 'user@example.com')

  const response = await app.request('/api/users/me', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = (await response.json()) as { user: Record<string, unknown> }

  expect(response.status).toBe(200)
  expect(body.user).toMatchObject({
    id: userId,
    email: 'user@example.com',
    role: 'user',
    displayName: null,
  })
})

test('updates and clears the display name for the authenticated user', async () => {
  const app = createApp({ env, prisma: createFakeDb() })
  const userId = '0196f6f8-6600-7000-8000-000000000002'
  const token = await signSupabaseToken(userId, 'user2@example.com')

  await app.request('/api/users/me', { headers: { Authorization: `Bearer ${token}` } })

  const update = await app.request('/api/users/me', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Ada Lovelace' }),
  })
  const updateBody = (await update.json()) as { user: Record<string, unknown> }
  expect(update.status).toBe(200)
  expect(updateBody.user.displayName).toBe('Ada Lovelace')

  const clear = await app.request('/api/users/me', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: null }),
  })
  const clearBody = (await clear.json()) as { user: Record<string, unknown> }
  expect(clear.status).toBe(200)
  expect(clearBody.user.displayName).toBeNull()
})

test('rejects requests with no token, an invalid token, or a token signed with the wrong secret', async () => {
  const app = createApp({ env, prisma: createFakeDb() })

  expect((await app.request('/api/users/me')).status).toBe(401)
  expect(
    (
      await app.request('/api/users/me', {
        headers: { Authorization: 'Bearer not-a-real-token' },
      })
    ).status,
  ).toBe(401)

  const wrongSecretToken = await signSupabaseToken(
    '0196f6f8-6600-7000-8000-000000000003',
    'x@example.com',
    { secret: 'a-completely-different-secret-value' },
  )
  expect(
    (
      await app.request('/api/users/me', {
        headers: { Authorization: `Bearer ${wrongSecretToken}` },
      })
    ).status,
  ).toBe(401)
})

test('rejects a token whose audience or role is not "authenticated"', async () => {
  const app = createApp({ env, prisma: createFakeDb() })
  const anonToken = await signSupabaseToken('0196f6f8-6600-7000-8000-000000000004', 'anon@example.com', {
    role: 'anon',
  })

  expect(
    (await app.request('/api/users/me', { headers: { Authorization: `Bearer ${anonToken}` } })).status,
  ).toBe(401)
})

test('rejects an invalid PATCH payload with the shared validation error shape', async () => {
  const app = createApp({ env, prisma: createFakeDb() })
  const userId = '0196f6f8-6600-7000-8000-000000000005'
  const token = await signSupabaseToken(userId, 'user5@example.com')
  await app.request('/api/users/me', { headers: { Authorization: `Bearer ${token}` } })

  const response = await app.request('/api/users/me', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'A' }),
  })
  const body = (await response.json()) as { error: { code: string } }

  expect(response.status).toBe(400)
  expect(body.error.code).toBe('VALIDATION_ERROR')
})

test('OpenAPI documents the users endpoints with bearer security', async () => {
  const app = createApp({ env, prisma: createFakeDb() })
  const response = await app.request('/openapi.json')
  const document = (await response.json()) as {
    components?: { securitySchemes?: Record<string, unknown> }
    paths: Record<string, { get?: { security?: unknown }; patch?: { security?: unknown } }>
  }

  expect(response.status).toBe(200)
  expect(document.components?.securitySchemes).toHaveProperty('BearerAuth')
  expect(document.paths['/api/users/me']?.get?.security).toEqual([{ BearerAuth: [] }])
  expect(document.paths['/api/users/me']?.patch?.security).toEqual([{ BearerAuth: [] }])
})
