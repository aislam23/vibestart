import { describe, expect, test } from 'bun:test'
import { SignJWT } from 'jose'

import { verifySupabaseAccessToken } from './jwt'

const secret = '12345678901234567890123456789012'
const userId = '0196f6f8-6600-7000-8000-000000000001'
const issuer = 'http://localhost:54321/auth/v1'

// `tokenIssuer: null` (not `undefined`, which would just fall back to the default below) opts out
// of `.setIssuer(...)` entirely, to build a token missing the `iss` claim.
function sign(
  claims: Record<string, unknown>,
  { signingSecret = secret, alg = 'HS256', tokenIssuer = issuer as string | null } = {},
) {
  let builder = new SignJWT(claims)
    .setProtectedHeader({ alg })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
  if (tokenIssuer !== null) builder = builder.setIssuer(tokenIssuer)
  return builder.sign(new TextEncoder().encode(signingSecret))
}

describe('verifySupabaseAccessToken', () => {
  test('accepts a well-formed authenticated Supabase access token', async () => {
    const token = await sign({
      email: 'user@example.com',
      aud: 'authenticated',
      role: 'authenticated',
      user_metadata: { display_name: 'Ada' },
    })

    await expect(verifySupabaseAccessToken(token, secret, issuer)).resolves.toEqual({
      userId,
      email: 'user@example.com',
      displayName: 'Ada',
    })
  })

  test('defaults displayName to null when user_metadata has none', async () => {
    const token = await sign({ email: 'user@example.com', aud: 'authenticated', role: 'authenticated' })

    await expect(verifySupabaseAccessToken(token, secret, issuer)).resolves.toMatchObject({
      displayName: null,
    })
  })

  test('rejects a missing token', async () => {
    await expect(verifySupabaseAccessToken(undefined, secret, issuer)).rejects.toThrow(
      'Authentication is required',
    )
  })

  test('rejects tokens signed with the wrong secret', async () => {
    const token = await sign(
      { email: 'user@example.com', aud: 'authenticated', role: 'authenticated' },
      { signingSecret: 'a-completely-different-secret-value' },
    )

    await expect(verifySupabaseAccessToken(token, secret, issuer)).rejects.toThrow(
      'Access token is invalid or expired',
    )
  })

  test('rejects any algorithm except HS256', async () => {
    const token = await sign(
      { email: 'user@example.com', aud: 'authenticated', role: 'authenticated' },
      { alg: 'HS384' },
    )

    await expect(verifySupabaseAccessToken(token, secret, issuer)).rejects.toThrow()
  })

  test('rejects a non-authenticated role or audience', async () => {
    const anonToken = await sign({ email: 'user@example.com', aud: 'authenticated', role: 'anon' })
    await expect(verifySupabaseAccessToken(anonToken, secret, issuer)).rejects.toThrow(
      'Access token is invalid or expired',
    )

    const wrongAud = await sign({ email: 'user@example.com', aud: 'anon', role: 'authenticated' })
    await expect(verifySupabaseAccessToken(wrongAud, secret, issuer)).rejects.toThrow(
      'Access token is invalid or expired',
    )
  })

  test('rejects an anon key shaped as a JWT', async () => {
    const token = await sign({ email: 'anon@example.com', aud: 'anon', role: 'anon' })

    await expect(verifySupabaseAccessToken(token, secret, issuer)).rejects.toThrow(
      'Access token is invalid or expired',
    )
  })

  test('rejects a service_role key shaped as a JWT', async () => {
    const token = await sign({ email: 'service@example.com', aud: 'service_role', role: 'service_role' })

    await expect(verifySupabaseAccessToken(token, secret, issuer)).rejects.toThrow(
      'Access token is invalid or expired',
    )
  })

  test('rejects a missing or non-UUID subject and a missing email', async () => {
    const noSub = await new SignJWT({ email: 'user@example.com', aud: 'authenticated', role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer(issuer)
      .sign(new TextEncoder().encode(secret))
    await expect(verifySupabaseAccessToken(noSub, secret, issuer)).rejects.toThrow()

    const noEmail = await sign({ aud: 'authenticated', role: 'authenticated' })
    await expect(verifySupabaseAccessToken(noEmail, secret, issuer)).rejects.toThrow()
  })

  test('rejects a token issued for a different project', async () => {
    const token = await sign(
      { email: 'user@example.com', aud: 'authenticated', role: 'authenticated' },
      { tokenIssuer: 'http://a-different-project.example.com/auth/v1' },
    )

    await expect(verifySupabaseAccessToken(token, secret, issuer)).rejects.toThrow(
      'Access token is invalid or expired',
    )
  })

  test('rejects a token with no issuer claim at all', async () => {
    const token = await sign(
      { email: 'user@example.com', aud: 'authenticated', role: 'authenticated' },
      { tokenIssuer: null },
    )

    await expect(verifySupabaseAccessToken(token, secret, issuer)).rejects.toThrow(
      'Access token is invalid or expired',
    )
  })

  test('rejects a token with no expiry claim at all', async () => {
    const token = await new SignJWT({ email: 'user@example.com', aud: 'authenticated', role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setIssuer(issuer)
      .sign(new TextEncoder().encode(secret))

    await expect(verifySupabaseAccessToken(token, secret, issuer)).rejects.toThrow(
      'Access token is invalid or expired',
    )
  })
})
