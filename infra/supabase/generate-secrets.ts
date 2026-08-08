#!/usr/bin/env bun
/**
 * Generates infra/supabase/.env from infra/supabase/.env.example, filling
 * every REPLACE_WITH_GENERATED_SECRET placeholder with a freshly generated
 * secret. Pure Bun/Node built-ins - no dependencies.
 *
 * This tool is install-only: by default it refuses to touch an existing
 * .env. Use --force to regenerate (see the warning it prints - overwriting
 * .env does NOT rotate secrets on a running stack; see README.md "Rotating
 * secrets" for the actual runbook).
 *
 * Usage (from repo root):
 *   bun run secrets:generate                     # dev-friendly defaults
 *   bun run secrets:generate -- --force           # regenerate, backs up old .env
 *   bun run secrets:generate -- --prod            # refuses unsafe prod defaults
 *   bun run secrets:generate -- --prod \
 *     --site-url=https://app.example.com \
 *     --api-external-url=https://supabase.example.com/auth/v1 \
 *     --public-url=https://supabase.example.com
 *
 * --site-url/--api-external-url/--public-url override the corresponding
 * .env.example values; without them, --prod validates whatever is already
 * set in .env.example (i.e. you can pre-edit .env.example instead of
 * passing flags).
 *
 * --api-external-url/--public-url MUST be the Supabase/Kong host
 * (SUPABASE_DOMAIN), never the backend API's own host (API_DOMAIN) - GoTrue
 * stamps API_EXTERNAL_URL as the `iss` claim on every token it issues, and
 * infra/app/.env's SUPABASE_JWT_ISSUER must match it exactly. --prod
 * rejects an API_DOMAIN-shaped value here (see looksLikeApiHostInsteadOfSupabaseHost
 * below) as a guard against this exact mix-up.
 */

import { randomBytes, createHmac } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const envExamplePath = join(scriptDir, ".env.example");
const envPath = join(scriptDir, ".env");

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function parseArgs(argv: string[]) {
  const flag = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const found = argv.find((a) => a.startsWith(prefix));
    return found?.slice(prefix.length);
  };
  return {
    force: argv.includes("--force"),
    prod: argv.includes("--prod"),
    siteUrl: flag("site-url"),
    apiExternalUrl: flag("api-external-url"),
    publicUrl: flag("public-url"),
  };
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function randomSecret(byteLength: number): string {
  return base64url(randomBytes(byteLength));
}

/** CSPRNG alphanumeric string via rejection sampling (no modulo bias). */
function randomAlphanumeric(length: number): string {
  const cutoff = 256 - (256 % ALPHANUMERIC.length);
  const chars: string[] = [];
  while (chars.length < length) {
    const byte = randomBytes(1)[0];
    if (byte < cutoff) {
      chars.push(ALPHANUMERIC[byte % ALPHANUMERIC.length]);
    }
  }
  return chars.join("");
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

export function isConcreteHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return false;
  if (host.endsWith(".localhost")) return false;
  return true;
}

/**
 * The `iss` claim GoTrue stamps on tokens is derived from API_EXTERNAL_URL - it MUST be the public
 * Supabase/Kong host (the one infra/edge's Caddyfile routes to `kong:8000`, see
 * infra/edge/Caddyfile's `{$SUPABASE_DOMAIN}` block and infra/app/.env.example's
 * SUPABASE_JWT_ISSUER comment), never the backend API's own host (`API_DOMAIN` in infra/edge) -
 * those are two different Caddy hosts pointing at two different upstreams. A cheap heuristic catch
 * for the most common copy-paste mistake: passing the API_DOMAIN value here instead of
 * SUPABASE_DOMAIN. Not exhaustive (nothing stops a legitimately-named host containing "api" as
 * part of a longer word), just a guard against the literal `api.` prefix mistake.
 */
function looksLikeApiHostInsteadOfSupabaseHost(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "api" || host.startsWith("api.");
  } catch {
    return false;
  }
}

/** Checks the --prod-unsafe combinations. Returns a list of human-readable failures. */
export function validateProd(values: Map<string, string>): string[] {
  const failures: string[] = [];

  const urlChecks: Array<[key: string, flag: string]> = [
    ["SITE_URL", "--site-url"],
    ["API_EXTERNAL_URL", "--api-external-url"],
    ["SUPABASE_PUBLIC_URL", "--public-url"],
  ];
  for (const [key, flag] of urlChecks) {
    const value = values.get(key);
    if (!isConcreteHttpsUrl(value)) {
      failures.push(
        `${key}=${value || "(empty)"} - --prod requires a concrete https:// URL (not loopback, not http://). ` +
          `Pass ${flag}=https://... or set ${key} in .env.example.`,
      );
    }
  }

  for (const [key, flag] of [
    ["API_EXTERNAL_URL", "--api-external-url"],
    ["SUPABASE_PUBLIC_URL", "--public-url"],
  ] as const) {
    const value = values.get(key);
    if (looksLikeApiHostInsteadOfSupabaseHost(value)) {
      failures.push(
        `${key}=${value} - this looks like the backend API host (API_DOMAIN), not the Supabase/Kong ` +
          `host (SUPABASE_DOMAIN). GoTrue stamps this URL as the \`iss\` claim on every token it issues, ` +
          `and infra/app/.env.example's SUPABASE_JWT_ISSUER must match it exactly - point ${flag} at your ` +
          `SUPABASE_DOMAIN (e.g. https://supabase.example.com), not API_DOMAIN.`,
      );
    }
  }

  const smtpConfigured = Boolean(values.get("SMTP_HOST")?.trim());
  const autoconfirm = (values.get("ENABLE_EMAIL_AUTOCONFIRM") ?? "").trim().toLowerCase() === "true";
  const signupOpen = (values.get("DISABLE_SIGNUP") ?? "").trim().toLowerCase() !== "true";

  // Autoconfirm-with-no-SMTP is only dangerous when signup is actually reachable - if
  // DISABLE_SIGNUP=true, nobody can sign up at all, so there is no unverified-email path to guard
  // against regardless of what ENABLE_EMAIL_AUTOCONFIRM is set to.
  if (autoconfirm && !smtpConfigured && signupOpen) {
    failures.push(
      "ENABLE_EMAIL_AUTOCONFIRM=true (-> GOTRUE_MAILER_AUTOCONFIRM) with no SMTP_HOST configured and " +
        "signup enabled - signups would be auto-confirmed with no email verification at all. Set " +
        "ENABLE_EMAIL_AUTOCONFIRM=false with working SMTP_* values, or set DISABLE_SIGNUP=true.",
    );
  }
  if (signupOpen && !smtpConfigured) {
    failures.push(
      "DISABLE_SIGNUP=false with no SMTP_HOST configured - open signup with no way to deliver " +
        "confirmation emails. Set DISABLE_SIGNUP=true, or configure SMTP_* values.",
    );
  }

  return failures;
}

function main(): void {
  const { force, prod, siteUrl, apiExternalUrl, publicUrl } = parseArgs(process.argv.slice(2));

  if (!existsSync(envExamplePath)) {
    console.error(`Missing ${envExamplePath}`);
    process.exit(1);
  }

  const lines = readFileSync(envExamplePath, "utf8").split("\n");

  const currentValues = new Map<string, string>();
  for (const line of lines) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) currentValues.set(match[1], match[2]);
  }
  if (siteUrl !== undefined) currentValues.set("SITE_URL", siteUrl);
  if (apiExternalUrl !== undefined) currentValues.set("API_EXTERNAL_URL", apiExternalUrl);
  if (publicUrl !== undefined) currentValues.set("SUPABASE_PUBLIC_URL", publicUrl);

  if (prod) {
    const failures = validateProd(currentValues);
    if (failures.length > 0) {
      console.error("--prod refuses to write .env - the following checks failed:\n");
      for (const f of failures) console.error(`  - ${f}`);
      console.error(
        "\nFix these (via --site-url/--api-external-url/--public-url flags, or by editing " +
          "infra/supabase/.env.example) and re-run.",
      );
      process.exit(1);
    }
  }

  const envExists = existsSync(envPath);
  if (envExists && !force) {
    console.error(
      `infra/supabase/.env already exists - refusing to overwrite it.\n` +
        `Pass --force to regenerate (this issues a new JWT_SECRET, which invalidates all existing sessions ` +
        `and API keys, and requires a manual rotation runbook on a running stack - see README.md "Rotating secrets").`,
    );
    process.exit(1);
  }

  let backupPath: string | undefined;
  if (envExists && force) {
    backupPath = join(scriptDir, `.env.backup.${Math.floor(Date.now() / 1000)}`);
    copyFileSync(envPath, backupPath);
    chmodSync(backupPath, 0o600);
  }

  const jwtSecret = randomSecret(32); // 43 chars, well over the 32-char minimum

  const secrets: Record<string, string> = {
    POSTGRES_PASSWORD: randomSecret(24),
    JWT_SECRET: jwtSecret,
    ANON_KEY: signApiKeyJwt("anon", jwtSecret),
    SERVICE_ROLE_KEY: signApiKeyJwt("service_role", jwtSecret),
    DASHBOARD_USERNAME: "supabase",
    DASHBOARD_PASSWORD: randomSecret(18),
    // Realtime requires exactly 16 characters (upstream suggests
    // `openssl rand -hex 8`, i.e. 16 hex chars = 64 bits). Using the full
    // alphanumeric alphabet over the same 16-character budget gets ~95 bits.
    REALTIME_DB_ENC_KEY: randomAlphanumeric(16),
    SECRET_KEY_BASE: randomSecret(48), // 64 chars, meets Realtime's 64-char minimum
    PG_META_CRYPTO_KEY: randomSecret(24),
    S3_PROTOCOL_ACCESS_KEY_ID: randomBytes(16).toString("hex"),
    S3_PROTOCOL_ACCESS_KEY_SECRET: randomBytes(32).toString("hex"),
  };

  const output = lines
    .map((line) => {
      const match = /^([A-Z0-9_]+)=/.exec(line);
      if (!match) return line;
      const key = match[1];
      if (key in secrets) return `${key}=${secrets[key]}`;
      if (key === "SITE_URL" && siteUrl !== undefined) return `${key}=${siteUrl}`;
      if (key === "API_EXTERNAL_URL" && apiExternalUrl !== undefined) return `${key}=${apiExternalUrl}`;
      if (key === "SUPABASE_PUBLIC_URL" && publicUrl !== undefined) return `${key}=${publicUrl}`;
      return line;
    })
    .join("\n");

  // Atomic write: exclusive temp file, then rename over the destination,
  // then an explicit chmod (covers a pre-existing .env with looser perms -
  // rename replaces the inode, but we don't rely on that alone).
  const tmpPath = join(scriptDir, `.env.tmp.${process.pid}.${randomBytes(4).toString("hex")}`);
  writeFileSync(tmpPath, output, { mode: 0o600, flag: "wx" });
  renameSync(tmpPath, envPath);
  chmodSync(envPath, 0o600);

  console.log(`Wrote infra/supabase/.env with ${Object.keys(secrets).length} generated secrets:`);
  for (const key of Object.keys(secrets)) console.log(`  - ${key}`);
  console.log("(values are not printed here - read them from infra/supabase/.env directly)");

  if (backupPath) {
    console.warn("");
    console.warn("=".repeat(78));
    console.warn(`WARNING: previous .env backed up to ${backupPath}`);
    console.warn("");
    console.warn("If the `db-data` Docker volume already exists (docker compose up has run");
    console.warn("before), Postgres already applied the OLD POSTGRES_PASSWORD and encryption");
    console.warn("keys on first boot and does NOT pick up the new .env values on restart. This");
    console.warn("new .env now has different secrets than the running database - just");
    console.warn("restarting the stack will break every service's DB connection.");
    console.warn("");
    console.warn('See README.md, "Rotating secrets", for the manual runbook (ALTER USER ...');
    console.warn("PASSWORD inside the running db, then update .env, then restart). Rotating");
    console.warn("JWT_SECRET additionally invalidates every issued token - the new ANON_KEY/");
    console.warn("SERVICE_ROLE_KEY above are already regenerated to match it.");
    console.warn("=".repeat(78));
  }

  console.log("");
  console.log("Next steps:");
  console.log("  cd infra/supabase && docker compose up -d");
  console.log("  Kong API gateway: http://localhost:54321");
  console.log("");
  console.log(
    "Storage defaults to STORAGE_BACKEND=file (local volume). For production, edit .env: set STORAGE_BACKEND=s3 and fill GLOBAL_S3_*/AWS_*/REGION.",
  );
}

// Guarded so this module can be `import`ed for tests (see generate-secrets.test.ts) without
// running main()'s process.exit-driven CLI flow.
if (import.meta.main) {
  main();
}
