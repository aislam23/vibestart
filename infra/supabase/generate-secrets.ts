#!/usr/bin/env bun
/**
 * Generates infra/supabase/.env from infra/supabase/.env.example, filling
 * every REPLACE_WITH_GENERATED_SECRET placeholder with a freshly generated
 * secret. Pure Bun/Node built-ins - no dependencies.
 *
 * Usage (from repo root):
 *   bun run secrets:generate
 *   bun run secrets:generate -- --force   # overwrite an existing .env
 */

import { randomBytes, createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const envExamplePath = join(scriptDir, ".env.example");
const envPath = join(scriptDir, ".env");

const force = process.argv.includes("--force");

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function randomSecret(byteLength: number): string {
  return base64url(randomBytes(byteLength));
}

function randomHex(byteLength: number): string {
  return randomBytes(byteLength).toString("hex");
}

/**
 * Signs a minimal Supabase-style API key JWT: HS256, claims
 * {"role", "iss": "supabase", "iat", "exp"} - the same claim shape used by
 * the official self-hosting docs' demo ANON_KEY/SERVICE_ROLE_KEY.
 */
function signApiKeyJwt(role: "anon" | "service_role", jwtSecret: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const tenYears = 10 * 365 * 24 * 60 * 60;

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    role,
    iss: "supabase",
    iat: nowSeconds,
    exp: nowSeconds + tenYears,
  };

  const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(
    Buffer.from(JSON.stringify(payload)),
  )}`;
  const signature = createHmac("sha256", jwtSecret).update(signingInput).digest();

  return `${signingInput}.${base64url(signature)}`;
}

function main(): void {
  if (existsSync(envPath) && !force) {
    console.error(
      `infra/supabase/.env already exists - refusing to overwrite it.\n` +
        `Pass --force to regenerate (this issues a new JWT_SECRET, which invalidates all existing sessions and API keys).`,
    );
    process.exit(1);
  }

  if (!existsSync(envExamplePath)) {
    console.error(`Missing ${envExamplePath}`);
    process.exit(1);
  }

  const jwtSecret = randomSecret(32); // 43 chars, well over the 32-char minimum

  const secrets: Record<string, string> = {
    POSTGRES_PASSWORD: randomSecret(24),
    JWT_SECRET: jwtSecret,
    ANON_KEY: signApiKeyJwt("anon", jwtSecret),
    SERVICE_ROLE_KEY: signApiKeyJwt("service_role", jwtSecret),
    DASHBOARD_USERNAME: "supabase",
    DASHBOARD_PASSWORD: randomSecret(18),
    REALTIME_DB_ENC_KEY: randomHex(8), // exactly 16 hex chars, required by Realtime
    SECRET_KEY_BASE: randomSecret(48), // 64 chars, meets Realtime's 64-char minimum
    PG_META_CRYPTO_KEY: randomSecret(24),
    S3_PROTOCOL_ACCESS_KEY_ID: randomHex(16),
    S3_PROTOCOL_ACCESS_KEY_SECRET: randomHex(32),
  };

  const lines = readFileSync(envExamplePath, "utf8").split("\n");
  const output = lines
    .map((line) => {
      const match = /^([A-Z0-9_]+)=/.exec(line);
      if (match && match[1] in secrets) {
        return `${match[1]}=${secrets[match[1]]}`;
      }
      return line;
    })
    .join("\n");

  writeFileSync(envPath, output, { mode: 0o600 });

  console.log(`Wrote infra/supabase/.env with ${Object.keys(secrets).length} generated secrets.`);
  console.log("");
  console.log(`Studio dashboard login (via Kong basic-auth):`);
  console.log(`  username: ${secrets.DASHBOARD_USERNAME}`);
  console.log(`  password: ${secrets.DASHBOARD_PASSWORD}`);
  console.log("");
  console.log("Next steps:");
  console.log("  cd infra/supabase && docker compose up -d");
  console.log("  Kong API gateway: http://localhost:54321");
  console.log("");
  console.log(
    "Storage defaults to STORAGE_BACKEND=file (local volume). For production, edit .env: set STORAGE_BACKEND=s3 and fill GLOBAL_S3_*/AWS_*/REGION.",
  );
}

main();
