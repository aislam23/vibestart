import { describe, expect, test } from 'bun:test'
import { SignJWT } from 'jose'

import { verifySupabaseAccessToken } from './jwt'

const secret = '12345678901234567890123456789012'
const userId = '0196f6f8-6600-7000-8000-000000000001'

function sign(claims: Record<string, unknown>, signingSecret = secret, alg = 'HS256') {
  return new SignJWT(claims)
    .setProtectedHeader({ alg })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(signingSecret))
}

describe('verifySupabaseAccessToken', () => {
  test('accepts a well-formed authenticated Supabase access token', async () => {
    const token = await sign({
      email: 'user@example.com',
      aud: 'authenticated',
      role: 'authenticated',
      user_metadata: { display_name: 'Ada' },
    })

    await expect(verifySupabaseAccessToken(token, secret)).resolves.toEqual({
      userId,
      email: 'user@example.com',
      displayName: 'Ada',
    })
  })

  test('defaults displayName to null when user_metadata has none', async () => {
    const token = await sign({ email: 'user@example.com', aud: 'authenticated', role: 'authenticated' })

    await expect(verifySupabaseAccessToken(token, secret)).resolves.toMatchObject({
      displayName: null,
    })
  })

  test('rejects a missing token', async () => {
    await expect(verifySupabaseAccessToken(undefined, secret)).rejects.toThrow(
      'Authentication is required',
    )
  })

  test('rejects tokens signed with the wrong secret', async () => {
    const token = await sign(
      { email: 'user@example.com', aud: 'authenticated', role: 'authenticated' },
      'a-completely-different-secret-value',
    )

    await expect(verifySupabaseAccessToken(token, secret)).rejects.toThrow(
      'Access token is invalid or expired',
    )
  })

  test('rejects any algorithm except HS256', async () => {
    const token = await sign(
      { email: 'user@example.com', aud: 'authenticated', role: 'authenticated' },
      secret,
      'HS384',
    )

    await expect(verifySupabaseAccessToken(token, secret)).rejects.toThrow()
  })

  test('rejects a non-authenticated role or audience', async () => {
    const anonToken = await sign({ email: 'user@example.com', aud: 'authenticated', role: 'anon' })
    await expect(verifySupabaseAccessToken(anonToken, secret)).rejects.toThrow(
      'Access token is invalid or expired',
    )

    const wrongAud = await sign({ email: 'user@example.com', aud: 'anon', role: 'authenticated' })
    await expect(verifySupabaseAccessToken(wrongAud, secret)).rejects.toThrow(
      'Access token is invalid or expired',
    )
  })

  test('rejects a missing or non-UUID subject and a missing email', async () => {
    const noSub = await new SignJWT({ email: 'user@example.com', aud: 'authenticated', role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret))
    await expect(verifySupabaseAccessToken(noSub, secret)).rejects.toThrow()

    const noEmail = await sign({ aud: 'authenticated', role: 'authenticated' })
    await expect(verifySupabaseAccessToken(noEmail, secret)).rejects.toThrow()
  })
})
