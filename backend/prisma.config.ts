import 'dotenv/config'
import { defineConfig } from 'prisma/config'

const localDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:54322/postgres'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: localDatabaseUrl,
  },
})
