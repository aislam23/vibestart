import { expect, test } from 'bun:test'
import type { AuthError } from '@supabase/supabase-js'

import { mapSupabaseAuthError } from '../src/features/auth/errors'

function authError(overrides: Partial<AuthError>): AuthError {
  return {
    name: 'AuthApiError',
    message: 'raw message',
    status: 400,
    code: undefined,
    ...overrides,
  } as AuthError
}

test('mapSupabaseAuthError translates known GoTrue codes to friendly messages', () => {
  const error = mapSupabaseAuthError(authError({ code: 'invalid_credentials', status: 400 }))
  expect(error.status).toBe(400)
  expect(error.code).toBe('invalid_credentials')
  expect(error.message).toBe('Incorrect email or password.')
})

test('mapSupabaseAuthError translates the duplicate-account code', () => {
  const error = mapSupabaseAuthError(authError({ code: 'user_already_exists', status: 422 }))
  expect(error.message).toBe('An account with this email already exists.')
})

test('mapSupabaseAuthError falls back to the raw GoTrue message for unknown codes', () => {
  const error = mapSupabaseAuthError(
    authError({ code: 'weak_password', status: 422, message: 'Password should be stronger' }),
  )
  expect(error.message).toBe('Password should be stronger')
})

test('mapSupabaseAuthError falls back to a default status when GoTrue omits one', () => {
  const error = mapSupabaseAuthError(authError({ status: undefined, message: 'network error' }))
  expect(error.status).toBe(400)
  expect(error.code).toBe('AUTH_ERROR')
  expect(error.message).toBe('network error')
})
