import type { ApiErrorCode, ApiErrorResponse } from '@vibestart/contracts'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'

export class AppError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message)
  }
}

export function errorResponse(
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): ApiErrorResponse {
  // `code` is deliberately the general ApiErrorCode union here (any call site can produce any
  // error code), while the contracts schema discriminates the `details` shape on a literal
  // 'VALIDATION_ERROR'. TS can't correlate the two without narrowing `code` to a literal first,
  // so the cast asserts what every call site already guarantees at runtime.
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  } as ApiErrorResponse
}

type ValidationHookResult = { success: true } | { success: false; error: ZodError }

export function validationErrorResponse(details: unknown) {
  return errorResponse('VALIDATION_ERROR', 'Invalid request payload', details)
}

export function validationErrorHook(result: ValidationHookResult, c: Context) {
  if (!result.success) {
    return c.json(validationErrorResponse(result.error.issues), 400)
  }
}

export function handleError(error: Error, c: Context) {
  if (error instanceof AppError) {
    if (error.headers) {
      for (const [name, value] of Object.entries(error.headers)) {
        c.header(name, value)
      }
    }
    return c.json(errorResponse(error.code, error.message, error.details), error.status)
  }

  if (error instanceof ZodError) {
    return c.json(validationErrorResponse(error.issues), 400)
  }

  if (error instanceof HTTPException) {
    return c.json(errorResponse('BAD_REQUEST', error.message), error.status)
  }

  console.error(error)
  return c.json(errorResponse('INTERNAL_ERROR', 'Unexpected server error'), 500)
}
