import { describe, expect, test } from 'bun:test'

import { checkArchitectureSources } from './architecture-check.mjs'

describe('backend layers', () => {
  test('accepts pure domain and application ports', () => {
    expect(check([file('backend/src/modules/users/domain/errors.ts', "import type { UserDto } from '@vibestart/contracts'")])).toEqual([])
  })

  test('rejects framework, persistence, env, and infrastructure from inner layers', () => {
    const violations = check([
      file('backend/src/modules/users/domain/errors.ts', "import { Hono } from 'hono'"),
      file('backend/src/modules/users/application/service.ts', "import { db } from '../../../env'"),
      file('backend/src/modules/users/application/service.ts', "import { repo } from '../infrastructure/repository'"),
    ])
    expect(violations.map((item) => item.rule)).toEqual([
      'backend-application-dependencies',
      'backend-application-dependencies',
      'backend-domain-dependencies',
    ])
  })

  test('rejects Prisma from transport while accepting application ports', () => {
    expect(check([file('backend/src/modules/users/transport/routes.ts', "import type { UsersService } from '../application/users-service'")])).toEqual([])
    expect(check([file('backend/src/modules/users/transport/routes.ts', "import { Prisma } from '../../../generated/prisma/client'")])[0]?.rule).toBe('backend-transport-dependencies')
  })

  test('rejects reverse imports between backend layers', () => {
    const violations = check([
      file('backend/src/modules/users/domain/errors.ts', "import { route } from '../transport/routes'"),
      file('backend/src/modules/users/transport/routes.ts', "import { repo } from '../infrastructure/repository'"),
      file('backend/src/modules/users/infrastructure/repository.ts', "import { route } from '../transport/routes'"),
    ])

    expect(violations.map((item) => item.rule)).toEqual([
      'backend-domain-dependencies',
      'backend-infrastructure-dependencies',
      'backend-transport-dependencies',
    ])
  })

  test('keeps provider SDKs out of transport', () => {
    const violation = check([
      file('backend/src/modules/users/transport/routes.ts', "import { jwtVerify } from 'jose'"),
    ])[0]

    expect(violation?.rule).toBe('backend-transport-dependencies')
  })
})

describe('public module and feature indexes', () => {
  test('accepts public indexes and rejects deep cross-context imports', () => {
    expect(check([file('backend/src/modules/users/application/service.ts', "import { read } from '../../auth-context'")])).toEqual([])
    expect(check([file('backend/src/modules/users/application/service.ts', "import { read } from '../../auth-context/middleware'")])[0]?.rule).toBe('backend-module-public-api')

    expect(check([file('webapp/src/features/auth/provider.tsx', "import { usePlan } from '../billing'")])).toEqual([])
    expect(check([file('webapp/src/features/auth/provider.tsx', "import { usePlan } from '../billing/provider'")])[0]?.rule).toBe('client-feature-public-api')

    expect(check([file('backend/src/app.ts', "import { auth } from './modules/auth-context'")])).toEqual([])
    const compositionViolation = check([
      file('backend/src/app.ts', "import { auth } from './modules/auth-context/middleware'"),
    ])[0]
    expect(compositionViolation?.rule).toBe('backend-module-public-api')
    expect(compositionViolation?.message).toContain(
      'code outside module auth-context must import it through its public index',
    )
  })
})

describe('dependency direction', () => {
  test('accepts feature imports from composition and rejects features from platform and UI', () => {
    expect(check([file('webapp/src/main.tsx', "import { AuthProvider } from '@/features/auth'")])).toEqual([])
    const violations = check([
      file('webapp/src/platform/api/http-client.ts', "import { AuthApi } from '@/features/auth'"),
      file('webapp/src/components/ui/button.tsx', "import { useAuth } from '@/features/auth'"),
    ])
    expect(violations.every((item) => item.rule === 'client-dependency-direction')).toBe(true)
  })

  test('requires composition code to use feature public indexes', () => {
    expect(check([file('webapp/src/pages.tsx', "import { AuthProvider } from '@/features/auth'")])).toEqual([])
    expect(check([file('webapp/src/pages.tsx', "import { AuthProvider } from '@/features/auth/provider'")])[0]?.rule)
      .toBe('client-feature-public-api')
  })

  test('keeps contracts framework- and product-independent', () => {
    expect(check([file('packages/contracts/src/auth.ts', "import { z } from 'zod'")])).toEqual([])
    expect(check([file('packages/contracts/src/auth.ts', "import { Hono } from 'hono'")])[0]?.rule).toBe('contracts-dependency-direction')
    expect(check([file('packages/contracts/src/auth.ts', "import { jwtVerify } from 'jose'")])[0]?.rule).toBe('contracts-dependency-direction')
  })

  test('checks dynamic imports and CommonJS require calls', () => {
    const violations = check([
      file('webapp/src/platform/lazy.ts', "const auth = import('@/features/auth/provider')"),
      file('packages/contracts/src/auth.ts', "const hono = require('hono')"),
    ])
    expect(violations.map((item) => item.rule)).toEqual([
      'contracts-dependency-direction',
      'client-dependency-direction',
      'client-feature-public-api',
    ])
  })
})

describe('regex bypasses closed by this check', () => {
  test('catches an import packed onto the same line as another statement', () => {
    // `import` declarations are valid JS/TS syntax anywhere in a module's statement sequence
    // (they are hoisted) - including right after a `;` on the same physical line, which line-start
    // anchoring alone missed.
    const violations = check([
      file(
        'backend/src/modules/users/application/service.ts',
        "const noop = 1; import { Prisma } from '../../../generated/prisma/client'",
      ),
    ])
    expect(violations.map((item) => item.rule)).toEqual(['backend-application-dependencies'])
  })

  test('sees through a comment between a dynamic import and its specifier', () => {
    const violations = check([
      file('backend/src/modules/users/transport/routes.ts', "const db = import(/* lazy */ 'pg')"),
    ])
    expect(violations.map((item) => item.rule)).toEqual(['backend-transport-dependencies'])
  })

  test('flags a template-literal dynamic import specifier as unresolvable instead of ignoring it', () => {
    const violations = check([
      file('backend/src/modules/users/transport/routes.ts', 'const mod = import(`pg`)'),
    ])
    expect(violations.map((item) => item.rule)).toEqual(['dynamic-import-unresolvable'])
  })

  test('forbids pg from the application and domain layers, alongside prisma', () => {
    const violations = check([
      file('backend/src/modules/users/application/service.ts', "import { Client } from 'pg'"),
    ])
    expect(violations.map((item) => item.rule)).toEqual(['backend-application-dependencies'])
  })

  test('matches a hyphenated package-family prefix like expo- against its members', () => {
    // `expo-router`, `expo-constants`, etc. share the literal `expo-` prefix directly (no `/`
    // separator), unlike a scoped package such as `@prisma/something`.
    const violations = check([
      file('packages/contracts/src/auth.ts', "import { useRouter } from 'expo-router'"),
    ])
    expect(violations.map((item) => item.rule)).toEqual(['contracts-dependency-direction'])
  })
})

function check(files) {
  return checkArchitectureSources(files)
}

function file(path, source) {
  return { path, source }
}
