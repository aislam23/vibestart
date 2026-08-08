import { describe, expect, test } from 'bun:test'

import { loadEnv } from './env'

const baseEnv = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:54322/postgres',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_JWT_SECRET: '12345678901234567890123456789012',
}

describe('loadEnv', () => {
  test('parses defaults and comma-separated origins', () => {
    const env = loadEnv({
      ...baseEnv,
      CORS_ORIGINS: 'http://localhost:5173, http://localhost:8081',
    })

    expect(env.PORT).toBe(3000)
    expect(env.SHUTDOWN_GRACE_SECONDS).toBe(20)
    expect(env.TRUST_PROXY).toBe(false)
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:8081'])
    expect(env.SERVICE_ROLE_KEY).toBeUndefined()
  })

  test('requires a well-formed SUPABASE_URL', () => {
    expect(() => loadEnv({ ...baseEnv, SUPABASE_URL: 'not-a-url' })).toThrow('SUPABASE_URL')
  })

  test('requires SUPABASE_JWT_SECRET to be at least 32 characters', () => {
    expect(() => loadEnv({ ...baseEnv, SUPABASE_JWT_SECRET: 'too-short' })).toThrow(
      'SUPABASE_JWT_SECRET',
    )
  })

  test('rejects known weak SUPABASE_JWT_SECRET values in production', () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        SUPABASE_JWT_SECRET: 'replace_with_supabase_jwt_secret',
        CORS_ORIGINS: 'https://web.example.com',
      }),
    ).toThrow('SUPABASE_JWT_SECRET')

    expect(() =>
      loadEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        SUPABASE_JWT_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        CORS_ORIGINS: 'https://web.example.com',
      }),
    ).toThrow('SUPABASE_JWT_SECRET')

    expect(() =>
      loadEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://web.example.com',
      }),
    ).not.toThrow()
  })

  test('rejects unsafe production CORS origins and allows HTTP outside production', () => {
    expect(() => loadEnv({ ...baseEnv, CORS_ORIGINS: '' })).toThrow('CORS_ORIGINS')
    expect(() => loadEnv({ ...baseEnv, CORS_ORIGINS: '*' })).toThrow('CORS_ORIGINS')
    expect(() => loadEnv({ ...baseEnv, CORS_ORIGINS: 'https://web.example.com/path' })).toThrow(
      'CORS_ORIGINS',
    )
    expect(() => loadEnv({ ...baseEnv, CORS_ORIGINS: 'http://web.example.com' })).not.toThrow()
    expect(() =>
      loadEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'http://web.example.com',
      }),
    ).toThrow('CORS_ORIGINS')
  })

  test('requires an explicit client IP header when a trusted proxy is enabled', () => {
    expect(() => loadEnv({ ...baseEnv, TRUST_PROXY: 'true' })).toThrow(
      'TRUSTED_PROXY_CLIENT_IP_HEADER',
    )
    expect(() =>
      loadEnv({
        ...baseEnv,
        TRUST_PROXY: 'true',
        TRUSTED_PROXY_CLIENT_IP_HEADER: 'do-connecting-ip',
      }),
    ).not.toThrow()
    expect(() =>
      loadEnv({
        ...baseEnv,
        TRUSTED_PROXY_CLIENT_IP_POSITION: 'first',
      }),
    ).toThrow('TRUSTED_PROXY_CLIENT_IP_POSITION')
  })
})
