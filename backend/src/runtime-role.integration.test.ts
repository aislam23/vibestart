import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, test } from 'bun:test'

import { createPrisma } from './db'

/**
 * Runs against the real `db_test` Postgres container, migrated and role-activated by
 * `bun run test:integration` (backend/scripts/test-integration.mjs). Skipped entirely under plain
 * `bun test`. See backend/README.md, "Runtime DB role", for what `backend_runtime` is and is not
 * allowed to do.
 */
const runtimeDatabaseUrl = process.env.TEST_RUNTIME_DATABASE_URL
const maybeDescribe = runtimeDatabaseUrl ? describe : describe.skip
const effectiveRuntimeDatabaseUrl =
  runtimeDatabaseUrl ?? 'postgresql://backend_runtime:postgres@localhost:5432/postgres'

maybeDescribe('backend_runtime least-privilege boundary', () => {
  const prisma = createPrisma(effectiveRuntimeDatabaseUrl)

  afterAll(async () => {
    await prisma.$disconnect()
  })

  test('cannot write to auth.users - GoTrue-owned, read-only for this role', async () => {
    // `expect(...).rejects` needs a native Promise - `$executeRaw` returns Prisma's own
    // thenable-but-not-`instanceof Promise` PrismaPromise, so it is wrapped here.
    await expect(
      Promise.resolve(
        prisma.$executeRaw`UPDATE auth.users SET email = 'hijacked@example.com' WHERE id = ${randomUUID()}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/i)
  })

  test('cannot CREATE TABLE - no DDL rights outside the migration role', async () => {
    await expect(
      Promise.resolve(prisma.$executeRaw`CREATE TABLE public._runtime_role_should_not_create (id uuid)`),
    ).rejects.toThrow(/permission denied/i)
  })

  test('can read and write its own application tables', async () => {
    const id = randomUUID()
    await prisma.$executeRaw`INSERT INTO public.profiles (id, role, created_at, updated_at) VALUES (${id}::uuid, 'user', now(), now())`
    const [row] = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM public.profiles WHERE id = ${id}::uuid`
    expect(row?.id).toBe(id)
    await prisma.$executeRaw`DELETE FROM public.profiles WHERE id = ${id}::uuid`
  })

  test('can read the auth.users columns the admin directory join needs (id, email)', async () => {
    // Does not throw: exactly the columns the migration grants, and the only ones the admin
    // directory's join (admin-users-repository.ts) reads.
    await prisma.$queryRaw`SELECT id, email FROM auth.users LIMIT 1`
  })
})
