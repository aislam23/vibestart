import { describe, expect, test } from "bun:test";

import { isConcreteHttpsUrl, validateProd } from "./generate-secrets";

const baseProdValues = (): Map<string, string> =>
  new Map([
    ["SITE_URL", "https://app.example.com"],
    ["API_EXTERNAL_URL", "https://supabase.example.com/auth/v1"],
    ["SUPABASE_PUBLIC_URL", "https://supabase.example.com"],
    ["DISABLE_SIGNUP", "true"],
    ["ENABLE_EMAIL_AUTOCONFIRM", "false"],
    ["SMTP_HOST", ""],
  ]);

describe("isConcreteHttpsUrl", () => {
  test("accepts a concrete https URL", () => {
    expect(isConcreteHttpsUrl("https://app.example.com")).toBe(true);
  });

  test("rejects loopback, http, and empty values", () => {
    expect(isConcreteHttpsUrl("http://app.example.com")).toBe(false);
    expect(isConcreteHttpsUrl("https://localhost")).toBe(false);
    expect(isConcreteHttpsUrl("https://127.0.0.1")).toBe(false);
    expect(isConcreteHttpsUrl(undefined)).toBe(false);
    expect(isConcreteHttpsUrl("not a url")).toBe(false);
  });
});

describe("validateProd", () => {
  test("passes with disabled signup and no SMTP configured (mode a: DISABLE_SIGNUP=true)", () => {
    const values = baseProdValues();
    values.set("DISABLE_SIGNUP", "true");
    values.set("ENABLE_EMAIL_AUTOCONFIRM", "true"); // irrelevant when nobody can sign up
    expect(validateProd(values)).toEqual([]);
  });

  test("passes with signup enabled, autoconfirm off, and SMTP configured (mode b: SMTP)", () => {
    const values = baseProdValues();
    values.set("DISABLE_SIGNUP", "false");
    values.set("ENABLE_EMAIL_AUTOCONFIRM", "false");
    values.set("SMTP_HOST", "smtp.example.com");
    expect(validateProd(values)).toEqual([]);
  });

  test("rejects autoconfirm + open signup + no SMTP", () => {
    const values = baseProdValues();
    values.set("DISABLE_SIGNUP", "false");
    values.set("ENABLE_EMAIL_AUTOCONFIRM", "true");
    values.set("SMTP_HOST", "");
    const failures = validateProd(values);
    expect(failures.some((f) => f.includes("ENABLE_EMAIL_AUTOCONFIRM=true"))).toBe(true);
  });

  test("rejects open signup with no SMTP even when autoconfirm is off", () => {
    const values = baseProdValues();
    values.set("DISABLE_SIGNUP", "false");
    values.set("ENABLE_EMAIL_AUTOCONFIRM", "false");
    values.set("SMTP_HOST", "");
    const failures = validateProd(values);
    expect(failures.some((f) => f.includes("DISABLE_SIGNUP=false"))).toBe(true);
  });

  test("rejects a non-https/loopback SITE_URL/API_EXTERNAL_URL/SUPABASE_PUBLIC_URL", () => {
    const values = baseProdValues();
    values.set("SITE_URL", "http://localhost:5173");
    const failures = validateProd(values);
    expect(failures.some((f) => f.startsWith("SITE_URL="))).toBe(true);
  });

  test("rejects API_EXTERNAL_URL/SUPABASE_PUBLIC_URL pointed at the API host instead of the Supabase host", () => {
    const values = baseProdValues();
    values.set("API_EXTERNAL_URL", "https://api.example.com/auth/v1");
    values.set("SUPABASE_PUBLIC_URL", "https://api.example.com");
    const failures = validateProd(values);
    expect(failures.some((f) => f.includes("API_EXTERNAL_URL") && f.includes("backend API host"))).toBe(true);
    expect(failures.some((f) => f.includes("SUPABASE_PUBLIC_URL") && f.includes("backend API host"))).toBe(true);
  });

  test("accepts a supabase-hosted API_EXTERNAL_URL/SUPABASE_PUBLIC_URL", () => {
    const values = baseProdValues();
    const failures = validateProd(values);
    expect(failures).toEqual([]);
  });
});
