import type { AuthError } from '@supabase/supabase-js'

import { ApiRequestError } from '@/platform/api'

// GoTrue error codes we give a friendlier message than the raw API text for. See
// https://supabase.com/docs/guides/auth/debugging/error-codes for the full list; anything not
// listed here falls back to `error.message`, which GoTrue already writes for end users.
const friendlyMessageByCode: Record<string, string> = {
  invalid_credentials: 'Incorrect email or password.',
  email_exists: 'An account with this email already exists.',
  user_already_exists: 'An account with this email already exists.',
  email_not_confirmed: 'Please confirm your email before signing in.',
  over_email_send_rate_limit: 'Too many attempts. Please wait a moment and try again.',
  over_request_rate_limit: 'Too many attempts. Please wait a moment and try again.',
  same_password: 'Please choose a different password than your current one.',
  session_not_found: 'This password reset link has expired. Please request a new one.',
}

/** Normalizes a supabase-js {@link AuthError} into the same shape forms already handle. */
export function mapSupabaseAuthError(error: AuthError): ApiRequestError {
  const code = error.code ?? 'AUTH_ERROR'
  const message = friendlyMessageByCode[code] ?? error.message
  return new ApiRequestError(error.status ?? 400, code, message)
}
