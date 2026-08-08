import 'dotenv/config'
import { defineConfig } from 'prisma/config'

// Schema changes (`prisma migrate`/`prisma migrate deploy`) need DDL privileges, which the
// least-privileged runtime role (`backend_runtime`, see the migration that creates it and
// backend/README.md's "Runtime DB role" section) deliberately does not have. `MIGRATE_DATABASE_URL`
// is the superuser connection for that; it falls back to `DATABASE_URL` so a local `.env` that only
// sets `DATABASE_URL` (the common case before `backend_runtime` is ever activated) keeps working
// unchanged.
const migrationDatabaseUrl =
  process.env.MIGRATE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:54322/postgres'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: migrationDatabaseUrl,
  },
})
