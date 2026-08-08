import { afterAll, describe, expect, test } from 'bun:test'

import { createPrisma } from './db'

/**
 * Runs against the real `db_test` Postgres container, migrated by `bun run test:integration`
 * (backend/scripts/test-integration.mjs). Skipped entirely under plain `bun test`. Exercises the
 * hand-written `uuidv7()` SQL function itself (see the `_init` migration's comment for why
 * PostgreSQL 17 needs one) - not any table, since `profiles` is the one app table that does not use
 * it (see prisma/schema.prisma).
 */
const databaseUrl = process.env.TEST_DATABASE_URL
const maybeDescribe = databaseUrl ? describe : describe.skip
const effectiveDatabaseUrl = databaseUrl ?? 'postgresql://supabase_admin:postgres@localhost:5432/postgres'

maybeDescribe('uuidv7() SQL function', () => {
  const prisma = createPrisma(effectiveDatabaseUrl)

  afterAll(async () => {
    await prisma.$disconnect()
  })

  test('sets the version nibble to 7 and the variant bits to 10, per RFC 9562', async () => {
    const [{ id }] = await prisma.$queryRaw<{ id: string }[]>`SELECT uuidv7() AS id`

    // xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx, where y is one of 8/9/a/b (the RFC 9562 variant bits).
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('orders two calls temporally, even a few milliseconds apart', async () => {
    const [{ id: first }] = await prisma.$queryRaw<{ id: string }[]>`SELECT uuidv7() AS id`
    await Bun.sleep(5)
    const [{ id: second }] = await prisma.$queryRaw<{ id: string }[]>`SELECT uuidv7() AS id`

    // The first 48 bits are a big-endian millisecond timestamp, so lexicographic string order
    // matches creation order as long as the two calls land in different milliseconds.
    expect(first < second).toBe(true)
  })
})
