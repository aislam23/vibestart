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
  expect(authQueryKeys.me()).toEqual(['session', 'auth', 'me'])
})

test('clearing session queries drops session-scoped cache and preserves public cache', async () => {
  const queryClient = new QueryClient()

  queryClient.setQueryData(authQueryKeys.me(), { user })
  queryClient.setQueryData([...sessionQueryKeys.all, 'admin', 'dashboard'], { totalUsers: 3 })
  queryClient.setQueryData(['public', 'plans'], [{ id: 'free' }])

  clearSessionQueries(queryClient)

  expect(queryClient.getQueryData(authQueryKeys.me())).toBeUndefined()
  expect(
    queryClient.getQueryData([...sessionQueryKeys.all, 'admin', 'dashboard']),
  ).toBeUndefined()
  expect(queryClient.getQueryData(['public', 'plans'])).toEqual([{ id: 'free' }])
})
