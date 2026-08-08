import { afterEach, expect, test } from 'bun:test'
import { z } from 'zod'

import { createAuthenticatedTransport } from '../src/platform/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const echoSchema = z.object({ ok: z.literal(true) })

test('authenticated transport injects the current bearer token', async () => {
  const calls: Array<{ authorization: string | null }> = []
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers)
    calls.push({ authorization: headers.get('Authorization') })
    return json({ ok: true }, 200)
  }

  const transport = createAuthenticatedTransport({
    getAccessToken: async () => 'access-token-1',
    refreshAccessToken: async () => 'access-token-2',
  })

  await expect(transport.request('/api/users/me', echoSchema)).resolves.toEqual({ ok: true })
  expect(calls).toEqual([{ authorization: 'Bearer access-token-1' }])
})

test('authenticated transport refreshes once and retries after a 401', async () => {
  const calls: Array<{ authorization: string | null }> = []
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers)
    const authorization = headers.get('Authorization')
    calls.push({ authorization })

    if (authorization === 'Bearer stale-token') {
      return json({ error: { code: 'UNAUTHORIZED', message: 'Expired access token' } }, 401)
    }
    return json({ ok: true }, 200)
  }

  let refreshCalls = 0
  const transport = createAuthenticatedTransport({
    getAccessToken: async () => 'stale-token',
    refreshAccessToken: async () => {
      refreshCalls += 1
      return 'fresh-token'
    },
  })

  await expect(transport.request('/api/users/me', echoSchema)).resolves.toEqual({ ok: true })
  expect(refreshCalls).toBe(1)
  expect(calls).toEqual([
    { authorization: 'Bearer stale-token' },
    { authorization: 'Bearer fresh-token' },
  ])
})

test('authenticated transport signs out and does not retry twice on a repeated 401', async () => {
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    return json({ error: { code: 'UNAUTHORIZED', message: 'Expired access token' } }, 401)
  }

  let refreshCalls = 0
  let authExpiredCalls = 0
  const transport = createAuthenticatedTransport({
    getAccessToken: async () => 'stale-token',
    refreshAccessToken: async () => {
      refreshCalls += 1
      return 'fresh-token'
    },
    onAuthExpired: async () => {
      authExpiredCalls += 1
    },
  })

  await expect(transport.request('/api/users/me', echoSchema)).rejects.toMatchObject({
    status: 401,
  })
  expect(fetchCalls).toBe(2)
  expect(refreshCalls).toBe(1)
  expect(authExpiredCalls).toBe(0)
})

test('authenticated transport signs out when the session cannot be refreshed', async () => {
  globalThis.fetch = async () =>
    json({ error: { code: 'UNAUTHORIZED', message: 'Expired access token' } }, 401)

  let authExpiredCalls = 0
  const transport = createAuthenticatedTransport({
    getAccessToken: async () => 'stale-token',
    refreshAccessToken: async () => null,
    onAuthExpired: async () => {
      authExpiredCalls += 1
    },
  })

  await expect(transport.request('/api/users/me', echoSchema)).rejects.toMatchObject({
    status: 401,
  })
  expect(authExpiredCalls).toBe(1)
})

test('authenticated transport passes non-401 errors straight through', async () => {
  globalThis.fetch = async () =>
    json({ error: { code: 'CONFLICT', message: 'Already exists' } }, 409)

  let refreshCalls = 0
  const transport = createAuthenticatedTransport({
    getAccessToken: async () => 'token',
    refreshAccessToken: async () => {
      refreshCalls += 1
      return 'token'
    },
  })

  await expect(transport.request('/api/users/me', echoSchema)).rejects.toMatchObject({
    status: 409,
    code: 'CONFLICT',
  })
  expect(refreshCalls).toBe(0)
})

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
