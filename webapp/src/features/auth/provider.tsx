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
import { type PropsWithChildren, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createAuthenticatedTransport } from '@/platform/api'
import { authBridge, supabase } from '@/platform/supabase'
import { AuthContext, type AuthContextValue, type RegisterOutcome } from './context'
import { mapSupabaseAuthError } from './errors'
import { isAuthBootstrapping } from './model'
import { authQueryKeys, clearSessionQueries, useCurrentUserQuery } from './queries'

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient()
  const [session, setSession] = useState<Session | null>(null)
  const [isSessionBootstrapping, setIsSessionBootstrapping] = useState(true)
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false)
  const previousUserIdRef = useRef<string | null>(null)

  // `authBridge` (platform/supabase/index.ts) has been subscribed to
  // `supabase.auth.onAuthStateChange` since module init - before React, let alone this effect,
  // ever ran - and buffers everything fired before `subscribe()` is first called here. That is
  // what makes `INITIAL_SESSION` a safe single source of truth for bootstrapping: no event fired
  // while supabase-js was parsing a recovery/PKCE-callback URL on load can be missed just because
  // this provider hadn't subscribed yet (see auth-bridge.ts's doc comment). There is no separate
  // `supabase.auth.getSession()` call here - it would just race the same information in twice.
  useEffect(() => {
    const unsubscribe = authBridge.subscribe((event, nextSession) => {
      const nextUserId = nextSession?.user.id ?? null
      const previousUserId = previousUserIdRef.current

      if (event === 'PASSWORD_RECOVERY') setIsPasswordRecovery(true)
      if (event === 'SIGNED_OUT') setIsPasswordRecovery(false)

      // Purge every session-scoped query BEFORE exposing the new principal (`setSession` below)
      // whenever the signed-in user id actually changes - a plain sign-out, one signed-in user
      // replacing another without an intervening `SIGNED_OUT` (e.g. a second account signing in
      // from another tab that shares this browser's storage), and a recovery session landing for a
      // different user than whoever was previously signed in here all go through this same check.
      if (nextUserId !== previousUserId) {
        clearSessionQueries(queryClient)
      }
      previousUserIdRef.current = nextUserId

      setSession(nextSession)
      setIsSessionBootstrapping(false)
    })

    return unsubscribe
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
          // Local scope only: this device/browser's session is what's actually gone (or the token
          // just failed a retry) - signing out globally would also kill every other device the
          // same account is legitimately signed in on, which nothing here has any evidence for.
          await supabase.auth.signOut({ scope: 'local' })
          clearSessionQueries(queryClient)
        },
        onForbidden: async () => {
          // The access token is still valid, but this principal's permissions changed underneath
          // it (e.g. an admin was demoted while this tab stayed open, or promoted and needs the
          // freshly admin-only queries to become available). Re-read `/me` to pick up the current
          // role and drop every cached admin query so a stale, now-forbidden result never lingers
          // on screen - the route guards in pages.tsx (`WorkspaceRoute`) react to the refreshed
          // role once it lands and reroute on their own.
          //
          // `invalidateQueries` on the shared prefix rather than a `meQuery.refetch()` call:
          // `transport` (this whole object) is created once and does not depend on `meQuery`, so it
          // has no query-key-specific handle to refetch, only `queryClient` itself - and it doesn't
          // need one, since `authQueryKeys.all` matches (and refetches) whichever `/me` query for
          // whichever user id is currently active without having to know that id here.
          await queryClient.invalidateQueries({ queryKey: authQueryKeys.all })
          queryClient.removeQueries({ queryKey: ['session', 'admin'] })
        },
      }),
    [queryClient],
  )

  const meQuery = useCurrentUserQuery({
    transport,
    enabled: !isSessionBootstrapping && Boolean(session),
    userId: session?.user.id ?? null,
  })

  const isBootstrapping = isAuthBootstrapping({
    isSessionBootstrapping,
    hasSession: Boolean(session),
    isMeQueryLoading: meQuery.isLoading,
  })

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
    // Local scope only - a user clicking "Log out" here means this device, not every device the
    // account is signed in on. See the matching comment on `onAuthExpired` above.
    const { error } = await supabase.auth.signOut({ scope: 'local' })
    if (error) throw mapSupabaseAuthError(error)
  }, [])

  const requestPasswordReset = useCallback(async (input: PasswordResetRequest) => {
    const payload = passwordResetRequestSchema.parse(input)
    const { error } = await supabase.auth.resetPasswordForEmail(payload.email, {
      // Routed through the dedicated `/auth/callback` handler (not straight to `/reset-password`)
      // so the PKCE code exchange has one consistent place to run and report failure - see
      // pages.tsx's `AuthCallbackPage`. `next` tells it where to continue once the recovery
      // session lands; validated there against a local-path allowlist before use.
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
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
