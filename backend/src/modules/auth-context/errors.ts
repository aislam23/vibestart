import { AppError } from '../../http/errors'

export type AuthContextFailureKind = 'missing_token' | 'invalid_token'

export class AuthContextFailure extends Error {
  constructor(
    public readonly kind: AuthContextFailureKind,
    message: string,
  ) {
    super(message)
  }
}

export function toAuthContextAppError(error: unknown) {
  if (!(error instanceof AuthContextFailure)) return error
  return new AppError(401, 'UNAUTHORIZED', error.message)
}

export async function executeAuthContext<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw toAuthContextAppError(error)
  }
}
