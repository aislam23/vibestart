import { QueryClient } from '@tanstack/react-query'
import { expect, test } from 'bun:test'

import { authQueryKeys, clearSessionQueries, sessionQueryKeys } from '../src/features/auth/queries'

const user = {
  id: 'user_1',
  email: 'user@example.com',
  displayName: null,
  role: 'user',
  createdAt: '2026-05-11T00:00:00.000Z',
}

test('session and auth query keys nest under the shared session prefix', () => {
  expect(sessionQueryKeys.all).toEqual(['session'])
  expect(authQueryKeys.all).toEqual(['session', 'auth'])
  expect(authQueryKeys.me('user_1')).toEqual(['session', 'auth', 'me', 'user_1'])
  expect(authQueryKeys.me(null)).toEqual(['session', 'auth', 'me', null])
})

test('the current-user query is scoped by supabase user id', () => {
  expect(authQueryKeys.me('user_1')).not.toEqual(authQueryKeys.me('user_2'))
})

test('clearing session queries drops session-scoped cache and preserves public cache', async () => {
  const queryClient = new QueryClient()

  queryClient.setQueryData(authQueryKeys.me('user_1'), { user })
  queryClient.setQueryData([...sessionQueryKeys.all, 'admin', 'dashboard'], { totalUsers: 3 })
  queryClient.setQueryData(['public', 'plans'], [{ id: 'free' }])

  clearSessionQueries(queryClient)

  expect(queryClient.getQueryData(authQueryKeys.me('user_1'))).toBeUndefined()
  expect(
    queryClient.getQueryData([...sessionQueryKeys.all, 'admin', 'dashboard']),
  ).toBeUndefined()
  expect(queryClient.getQueryData(['public', 'plans'])).toEqual([{ id: 'free' }])
})

test('switching identity leaves no stale data behind for the next principal', async () => {
  const queryClient = new QueryClient()

  // user_1 was signed in and had a populated cache...
  queryClient.setQueryData(authQueryKeys.me('user_1'), { user })
  queryClient.setQueryData([...sessionQueryKeys.all, 'admin', 'dashboard'], { totalUsers: 3 })

  // ...AuthProvider observes the session's user id change and purges before exposing user_2 as
  // the new principal.
  clearSessionQueries(queryClient)

  expect(queryClient.getQueryData(authQueryKeys.me('user_1'))).toBeUndefined()
  expect(queryClient.getQueryData(authQueryKeys.me('user_2'))).toBeUndefined()
  expect(
    queryClient.getQueryData([...sessionQueryKeys.all, 'admin', 'dashboard']),
  ).toBeUndefined()
})
