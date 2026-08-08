import { AppError } from '../../../http/errors'
import { UsersFailure } from '../domain/errors'

export function toUsersAppError(error: unknown) {
  if (!(error instanceof UsersFailure)) return error

  if (error.kind === 'not_found') {
    return new AppError(404, 'NOT_FOUND', error.message)
  }
  if (error.kind === 'forbidden') {
    return new AppError(403, 'FORBIDDEN', error.message)
  }
  if (error.kind === 'lock_timeout') {
    const retryAfterSeconds = error.retryAfterSeconds ?? 5
    return new AppError(409, 'CONFLICT', error.message, undefined, {
      'Retry-After': String(retryAfterSeconds),
    })
  }
  return new AppError(409, 'CONFLICT', error.message)
}

export async function executeUsers<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw toUsersAppError(error)
  }
}
