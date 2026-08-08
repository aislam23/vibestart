export type UsersFailureKind = 'not_found' | 'role_conflict' | 'forbidden' | 'lock_timeout'

export class UsersFailure extends Error {
  constructor(
    public readonly kind: UsersFailureKind,
    message: string,
    /** Seconds the caller should wait before retrying. Only meaningful for `lock_timeout`. */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}
