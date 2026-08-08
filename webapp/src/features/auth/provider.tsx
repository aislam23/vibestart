import { useQueryClient } from '@tanstack/react-query'
import {
  loginRequestSchema,
  passwordResetRequestSchema,
  registerRequestSchema,
  type LoginRequest,
  type PasswordResetRequest,
  type RegisterRequest,
} from '@vibestart/contracts'
import type { Session } from '@supabase/supabase-js'
import { type PropsWithChildren, useCallback, useEffect, useMemo, useState } from 'react'

import { createAuthenticatedTransport } from '@/platform/api'
import { supabase } from '@/platform/supabase'
import { AuthContext, type AuthContextValue, type RegisterOutcome } from './context'
import { mapSupabaseAuthError } from './errors'
import { clearSessionQueries, useCurrentUserQuery } from './queries'

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient()
  const [session, setSession] = useState<Session | null>(null)
  const [isBootstrapping, setIsBootstrapping] = useState(true)
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false)

  // supabase-js owns the token lifecycle end to end: it persists the session to localStorage,
  // auto-refreshes the access token before it expires, and parses recovery/confirmation tokens
  // out of the URL on load. This effect only mirrors that state into React and reacts to the
  // `PASSWORD_RECOVERY` event the reset-password flow needs.
  useEffect(() => {
    let isMounted = true

    supabase.auth.getSession().then(({ data }) => {
      if (!isMounted) return
      setSession(data.session)
      setIsBootstrapping(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'PASSWORD_RECOVERY') setIsPasswordRecovery(true)
      if (event === 'SIGNED_OUT') {
        setIsPasswordRecovery(false)
        clearSessionQueries(queryClient)
      }

      setSession(nextSession)
      setIsBootstrapping(false)
    })

    return () => {
      isMounted = false
      listener.subscription.unsubscribe()
    }
  }, [queryClient])

  const transport = useMemo(
    () =>
      createAuthenticatedTransport({
        getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
        refreshAccessToken: async () => {
          const { data, error } = await supabase.auth.refreshSession()
          return error ? null : (data.session?.access_token ?? null)
        },
        onAuthExpired: async () => {
          await supabase.auth.signOut()
          clearSessionQueries(queryClient)
        },
      }),
    [queryClient],
  )

  const meQuery = useCurrentUserQuery({ transport, enabled: !isBootstrapping && Boolean(session) })

  const register = useCallback(async (input: RegisterRequest): Promise<RegisterOutcome> => {
    const payload = registerRequestSchema.parse(input)
    const { data, error } = await supabase.auth.signUp({
      email: payload.email,
      password: payload.password,
      options: payload.displayName ? { data: { display_name: payload.displayName } } : undefined,
    })
    if (error) throw mapSupabaseAuthError(error)
    return data.session ? 'signed-in' : 'confirmation-required'
  }, [])

  const login = useCallback(async (input: LoginRequest) => {
    const payload = loginRequestSchema.parse(input)
    const { error } = await supabase.auth.signInWithPassword(payload)
    if (error) throw mapSupabaseAuthError(error)
  }, [])

  const logout = useCallback(async () => {
    const { error } = await supabase.auth.signOut()
    if (error) throw mapSupabaseAuthError(error)
  }, [])

  const requestPasswordReset = useCallback(async (input: PasswordResetRequest) => {
    const payload = passwordResetRequestSchema.parse(input)
    const { error } = await supabase.auth.resetPasswordForEmail(payload.email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    if (error) throw mapSupabaseAuthError(error)
  }, [])

  const updatePassword = useCallback(async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password })
    if (error) throw mapSupabaseAuthError(error)
    setIsPasswordRecovery(false)
  }, [])

  const retrySession = useCallback(async () => {
    await meQuery.refetch()
  }, [meQuery])

  const sessionError = session ? toOptionalError(meQuery.error) : null

  const value = useMemo<AuthContextValue>(
    () => ({
      user: meQuery.data?.user ?? null,
      isBootstrapping,
      isAuthenticated: Boolean(meQuery.data?.user),
      isPasswordRecovery,
      sessionError,
      retrySession,
      transport,
      register,
      login,
      logout,
      requestPasswordReset,
      updatePassword,
    }),
    [
      isBootstrapping,
      isPasswordRecovery,
      login,
      logout,
      meQuery.data?.user,
      register,
      requestPasswordReset,
      retrySession,
      sessionError,
      transport,
      updatePassword,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

function toOptionalError(error: unknown) {
  if (error === null || error === undefined) return null
  return error instanceof Error ? error : new Error('Unknown session error')
}
