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
  /** Called once a refreshed token still gets a 401 - the session is treated as gone. */
  onAuthExpired?: () => void | Promise<void>
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
  http = new HttpClient(),
}: CreateAuthenticatedTransportOptions): AuthenticatedTransport {
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
      if (!(error instanceof ApiRequestError) || error.status !== 401 || isRetry) {
        throw error
      }

      // Use the token `refreshAccessToken` just handed back directly, rather than calling
      // `getAccessToken` again - that avoids depending on the refresh having already landed in
      // whatever store `getAccessToken` reads from by the time this retry fires.
      const refreshedToken = await refreshAccessToken()
      if (!refreshedToken) {
        await onAuthExpired?.()
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
