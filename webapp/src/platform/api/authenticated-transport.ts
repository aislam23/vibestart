import type { z } from 'zod'

import { ApiRequestError, HttpClient, type HttpRequestOptions } from './http-client'

export type AuthenticatedTransport = {
  request<TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    options?: HttpRequestOptions,
  ): Promise<z.infer<TSchema>>
}

type CreateAuthenticatedTransportOptions = {
  /** Reads the current access token without forcing a refresh (supabase-js keeps it fresh). */
  getAccessToken: () => Promise<string | null>
  /** Forces a refresh and returns the new access token, or null when the session cannot be revived. */
  refreshAccessToken: () => Promise<string | null>
  /** Called when the session cannot be revived: either `refreshAccessToken` returned null, or the
   * retried request with a freshly refreshed token still gets a 401. Either way the session is
   * treated as gone. */
  onAuthExpired?: () => void | Promise<void>
  /** Called on a 403 from an already-authenticated request - the token is valid but the principal
   * no longer has permission (e.g. an admin demoted while a tab stayed open). Distinct from
   * `onAuthExpired`: the session itself is still fine, only the caller's authorization changed. */
  onForbidden?: () => void | Promise<void>
  http?: HttpClient
}

/**
 * Builds an {@link AuthenticatedTransport} that injects `Authorization: Bearer <token>` from
 * whatever session source the caller provides. This module stays framework-agnostic on purpose
 * (`platform` must not import product features, see docs/ARCHITECTURE.md) - the auth feature
 * composes it with supabase-js-backed token getters instead of this module importing supabase
 * directly.
 */
export function createAuthenticatedTransport({
  getAccessToken,
  refreshAccessToken,
  onAuthExpired,
  onForbidden,
  http = new HttpClient(),
}: CreateAuthenticatedTransportOptions): AuthenticatedTransport {
  // Deduplicates `onAuthExpired` across requests that fail concurrently (e.g. several queries in
  // flight when the session dies) - without this, N concurrently-failing requests would each call
  // it once. The in-flight promise is cleared once it settles, not kept forever, so a later, wholly
  // separate expiry (a fresh sign-in that itself later expires) still notifies again.
  let authExpiredNotification: Promise<void> | null = null
  const notifyAuthExpired = () => {
    if (!authExpiredNotification) {
      authExpiredNotification = Promise.resolve(onAuthExpired?.()).finally(() => {
        authExpiredNotification = null
      })
    }
    return authExpiredNotification
  }

  async function performRequest<TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    options: HttpRequestOptions,
    accessToken: string | null,
    isRetry: boolean,
  ): Promise<z.infer<TSchema>> {
    const headers = new Headers(options.headers)
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)

    try {
      return await http.request(path, schema, { ...options, headers })
    } catch (error) {
      if (!(error instanceof ApiRequestError)) throw error

      if (error.status === 403) {
        await onForbidden?.()
        throw error
      }

      if (error.status !== 401) throw error

      if (isRetry) {
        // The retry (already on a freshly refreshed token) still got a 401 - the session is gone,
        // not just stale.
        await notifyAuthExpired()
        throw error
      }

      // Use the token `refreshAccessToken` just handed back directly, rather than calling
      // `getAccessToken` again - that avoids depending on the refresh having already landed in
      // whatever store `getAccessToken` reads from by the time this retry fires.
      const refreshedToken = await refreshAccessToken()
      if (!refreshedToken) {
        await notifyAuthExpired()
        throw error
      }

      return performRequest(path, schema, options, refreshedToken, true)
    }
  }

  return {
    request: async (path, schema, options = {}) =>
      performRequest(path, schema, options, await getAccessToken(), false),
  }
}
