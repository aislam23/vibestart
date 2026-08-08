import type { LoginRequest, PasswordResetRequest, RegisterRequest, UserDto } from '@vibestart/contracts'
import { createContext } from 'react'
import type { AuthenticatedTransport } from '@/platform/api'

/**
 * `signed-in` when Supabase returned a session immediately (local dev has email autoconfirm
 * on); `confirmation-required` when it did not (production SMTP setups that require the user to
 * click a confirmation link before a session exists).
 */
export type RegisterOutcome = 'signed-in' | 'confirmation-required'

export type AuthContextValue = {
  user: UserDto | null
  isBootstrapping: boolean
  isAuthenticated: boolean
  /** True from the moment Supabase fires a `PASSWORD_RECOVERY` auth event until the password is updated. */
  isPasswordRecovery: boolean
  sessionError: Error | null
  retrySession: () => Promise<void>
  transport: AuthenticatedTransport
  register: (input: RegisterRequest) => Promise<RegisterOutcome>
  login: (input: LoginRequest) => Promise<void>
  logout: () => Promise<void>
  requestPasswordReset: (input: PasswordResetRequest) => Promise<void>
  updatePassword: (password: string) => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)
