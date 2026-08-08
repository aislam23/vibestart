import { expect, test } from 'bun:test'

import { isAuthBootstrapping } from '../src/features/auth/model'

test('bootstrapping stays true until the session is known', () => {
  expect(
    isAuthBootstrapping({ isSessionBootstrapping: true, hasSession: false, isMeQueryLoading: false }),
  ).toBe(true)
  expect(
    isAuthBootstrapping({ isSessionBootstrapping: true, hasSession: true, isMeQueryLoading: false }),
  ).toBe(true)
})

test('bootstrapping ends immediately once the session is known and there is no session to fetch /me for', () => {
  expect(
    isAuthBootstrapping({ isSessionBootstrapping: false, hasSession: false, isMeQueryLoading: false }),
  ).toBe(false)
})

test('bootstrapping stays true while a known session\'s initial /me fetch is still pending - a route guard must not treat this tick as signed out', () => {
  expect(
    isAuthBootstrapping({ isSessionBootstrapping: false, hasSession: true, isMeQueryLoading: true }),
  ).toBe(true)
})

test('bootstrapping ends once a known session\'s /me fetch has resolved', () => {
  expect(
    isAuthBootstrapping({ isSessionBootstrapping: false, hasSession: true, isMeQueryLoading: false }),
  ).toBe(false)
})
