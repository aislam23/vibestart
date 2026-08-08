-- Repository-standard uuidv7() function.
--
-- PostgreSQL 17 (the version shipped by the self-hosted Supabase image,
-- supabase/postgres:17.6.1.136) has no built-in uuidv7() - that only arrives
-- in PostgreSQL 18. This is a pure plpgsql, timestamp-ordered implementation
-- of RFC 9562 UUIDv7: the first 48 bits are the current Unix time in
-- milliseconds (big-endian), the remaining 74 bits are random, with the
-- 4-bit version set to 0111 and the 2-bit variant set to 10 per the RFC.
-- Values are therefore lexicographically (and index-) sortable by creation
-- time to millisecond resolution, with random tie-breaking within the same
-- millisecond.
--
-- Every app table OTHER than `profiles` (see schema.prisma for why profiles
-- is the exception) generates its primary key with this function:
--   id String @id @default(dbgenerated("uuidv7()")) @db.Uuid
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  ts_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  ts_bytes bytea := substring(int8send(ts_ms) FROM 3 FOR 6);
  rand_bytes bytea := uuid_send(gen_random_uuid());
  uuid_bytes bytea;
BEGIN
  uuid_bytes := ts_bytes || substring(rand_bytes FROM 7 FOR 10);
  -- Force the version nibble (bits 48-51) to 0111 (version 7), keep the rest of that byte random.
  uuid_bytes := set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 112);
  -- Force the variant bits (top 2 bits of byte 8) to 10, keep the rest of that byte random.
  uuid_bytes := set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END;
$$;

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('user', 'admin');

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'user',
    "display_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);
