import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import { handleError } from '../../http/errors'
import { AuthContextFailure } from './errors'
import { createRequireAdmin, createRequireAuth, type AuthHttpEnv } from './middleware'

describe('requireAuth middleware', () => {
  test('rejects missing and invalid bearer tokens', async () => {
    const app = createProtectedTestApp()

    const missing = await app.request('/protected')
    expect(missing.status).toBe(401)

    const invalid = await app.request('/protected', {
      headers: { Authorization: 'Bearer invalid-token' },
    })
    expect(invalid.status).toBe(401)
  })

  test('sets the typed authenticated principal for downstream handlers', async () => {
    const app = createProtectedTestApp()
    const response = await app.request('/protected', {
      headers: { Authorization: 'Bearer valid-token' },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      email: 'user@example.com',
      role: 'user',
      userId: '0196f6f8-6600-7000-8000-000000000001',
    })
  })
})

describe('requireAdmin middleware', () => {
  test('rejects an authenticated non-admin principal with 403', async () => {
    const app = createAdminTestApp('user')
    const response = await app.request('/admin-only', {
      headers: { Authorization: 'Bearer valid-token' },
    })

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('FORBIDDEN')
  })

  test('lets an admin principal through', async () => {
    const app = createAdminTestApp('admin')
    const response = await app.request('/admin-only', {
      headers: { Authorization: 'Bearer valid-token' },
    })

    expect(response.status).toBe(200)
  })

  test('still requires authentication first', async () => {
    const app = createAdminTestApp('admin')
    const response = await app.request('/admin-only')

    expect(response.status).toBe(401)
  })
})

function createAdminTestApp(role: 'user' | 'admin') {
  const app = new Hono<AuthHttpEnv>()
  const requireAuth = createRequireAuth(async (accessToken) => {
    if (accessToken !== 'valid-token') {
      throw new AuthContextFailure('invalid_token', 'Access token is invalid or expired')
    }

    return {
      id: '0196f6f8-6600-7000-8000-000000000001',
      email: 'user@example.com',
      displayName: null,
      role,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }
  })
  const requireAdmin = createRequireAdmin()

  app.use('*', requireAuth)
  app.get('/admin-only', requireAdmin, (c) => c.json({ ok: true }))
  app.onError(handleError)

  return app
}

function createProtectedTestApp() {
  const app = new Hono<AuthHttpEnv>()
  const requireAuth = createRequireAuth(async (accessToken) => {
    if (accessToken !== 'valid-token') {
      throw new AuthContextFailure('invalid_token', 'Access token is invalid or expired')
    }

    return {
      id: '0196f6f8-6600-7000-8000-000000000001',
      email: 'user@example.com',
      displayName: null,
      role: 'user' as const,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }
  })

  app.use('*', requireAuth)
  app.get('/protected', (c) => {
    const user = c.var.user
    return c.json({
      email: user.email,
      role: user.role,
      userId: user.id,
    })
  })
  app.onError(handleError)

  return app
}
