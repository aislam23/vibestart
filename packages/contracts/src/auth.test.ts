// Modified from the Vibe Coding Template (https://github.com/di-sukharev/vibe), Apache-2.0. See NOTICE.
import { describe, expect, test } from 'bun:test'

import type { UserDto } from './index'
import {
  apiErrorSchema,
  loginRequestSchema,
  meResponseSchema,
  passwordResetRequestResponseSchema,
  passwordResetRequestSchema,
  registerRequestSchema,
  userSchema,
} from './index'

const validUser = {
  id: '019c0000-0000-7000-8000-000000000001',
  email: 'user@example.com',
  displayName: null,
  role: 'user',
  createdAt: '2026-05-11T00:00:00.000Z',
} satisfies UserDto

describe('auth contracts', () => {
  test('normalizes registration and login input', () => {
    expect(
      registerRequestSchema.parse({
        email: ' USER@Example.COM ',
        password: 'password123',
        displayName: ' Jane ',
      }),
    ).toEqual({
      email: 'user@example.com',
      password: 'password123',
      displayName: 'Jane',
    })

    expect(
      registerRequestSchema.parse({
        email: 'user@example.com',
        password: 'password123',
        displayName: '',
      }),
    ).toEqual({
      email: 'user@example.com',
      password: 'password123',
      displayName: undefined,
    })

    expect(
      loginRequestSchema.parse({
        email: ' USER@Example.COM ',
        password: 'password123',
      }),
    ).toEqual({
      email: 'user@example.com',
      password: 'password123',
    })
  })

  test('rejects invalid auth request payloads', () => {
    expect(() =>
      registerRequestSchema.parse({
        email: 'not-an-email',
        password: 'short',
        displayName: 'A',
      }),
    ).toThrow()

    expect(() =>
      registerRequestSchema.parse({
        email: 'user@example.com',
        password: 'password123',
        displayName: '   ',
      }),
    ).toThrow()

    expect(() =>
      registerRequestSchema.parse({
        email: 'user@example.com',
        password: 'password123',
        displayName: 'Jane',
        role: 'admin',
      }),
    ).toThrow()
  })

  test('decouples login password validation from the registration password policy', () => {
    expect(
      loginRequestSchema.parse({
        email: 'user@example.com',
        password: 'short',
      }),
    ).toEqual({
      email: 'user@example.com',
      password: 'short',
    })

    expect(() =>
      loginRequestSchema.parse({
        email: 'user@example.com',
        password: '',
      }),
    ).toThrow()

    expect(() =>
      loginRequestSchema.parse({
        email: 'user@example.com',
        password: 'a'.repeat(257),
      }),
    ).toThrow()
  })

  test('rejects user DTOs with unexpected fields', () => {
    expect(() =>
      userSchema.parse({
        ...validUser,
        passwordHash: 'must-not-leak',
      }),
    ).toThrow()
  })

  test('normalizes password reset requests and keeps their response generic', () => {
    expect(passwordResetRequestSchema.parse({ email: ' USER@Example.COM ' })).toEqual({
      email: 'user@example.com',
    })
    expect(passwordResetRequestResponseSchema.parse({ accepted: true })).toEqual({
      accepted: true,
    })
    expect(() => passwordResetRequestResponseSchema.parse({ accepted: false })).toThrow()
  })

  test('validates the generic profile response shape', () => {
    expect(meResponseSchema.parse({ user: validUser })).toEqual({ user: validUser })
  })

  test('validates stable API error response shape', () => {
    expect(
      apiErrorSchema.parse({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request payload',
          details: [{ path: ['email'], message: 'Invalid email address' }],
        },
      }),
    ).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request payload',
        details: [{ path: ['email'], message: 'Invalid email address' }],
      },
    })

    expect(() =>
      apiErrorSchema.parse({
        error: {
          code: 'SOMETHING_ELSE',
          message: 'Nope',
        },
      }),
    ).toThrow()

    expect(() =>
      apiErrorSchema.parse({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong',
          details: [{ path: ['email'], message: 'Invalid email address' }],
        },
      }),
    ).toThrow()
  })
})
