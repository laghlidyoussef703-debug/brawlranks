/**
 * lib/env.ts — strict validation of NEXT_PUBLIC_SITE_URL/APP_ENV.
 * Mutates process.env directly and restores it after each assertion,
 * matching this repository's existing convention for env-dependent tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const ORIGINAL_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;
const ORIGINAL_APP_ENV = process.env.APP_ENV;

function restoreEnv() {
  if (ORIGINAL_SITE_URL === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_SITE_URL;
  if (ORIGINAL_APP_ENV === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = ORIGINAL_APP_ENV;
}

test("getAppEnv: returns 'development' when APP_ENV is unset", async () => {
  delete process.env.APP_ENV;
  const { getAppEnv } = await import("@/lib/env");
  assert.equal(getAppEnv(), "development");
  restoreEnv();
});

test("getAppEnv: returns 'development' (fails closed) for an unrecognized value, never 'production'", async () => {
  process.env.APP_ENV = "prod"; // a common typo for "production" — must NOT be accepted
  const { getAppEnv } = await import("@/lib/env");
  assert.equal(getAppEnv(), "development");
  restoreEnv();
});

test("getAppEnv: accepts exactly 'staging' and 'production'", async () => {
  const { getAppEnv } = await import("@/lib/env");
  process.env.APP_ENV = "staging";
  assert.equal(getAppEnv(), "staging");
  process.env.APP_ENV = "production";
  assert.equal(getAppEnv(), "production");
  restoreEnv();
});

test("isProduction: true only when APP_ENV is exactly 'production'", async () => {
  const { isProduction } = await import("@/lib/env");
  process.env.APP_ENV = "production";
  assert.equal(isProduction(), true);
  process.env.APP_ENV = "staging";
  assert.equal(isProduction(), false);
  restoreEnv();
});

test("getSiteUrl: throws a clear error when NEXT_PUBLIC_SITE_URL is unset", async () => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
  const { getSiteUrl } = await import("@/lib/env");
  assert.throws(() => getSiteUrl(), /NEXT_PUBLIC_SITE_URL is not set/);
  restoreEnv();
});

test("getSiteUrl: throws for a non-absolute-URL value", async () => {
  process.env.NEXT_PUBLIC_SITE_URL = "not-a-url";
  const { getSiteUrl } = await import("@/lib/env");
  assert.throws(() => getSiteUrl(), /not a valid absolute URL/);
  restoreEnv();
});

test("getSiteUrl: throws for a non-http(s) protocol", async () => {
  process.env.NEXT_PUBLIC_SITE_URL = "ftp://example.com";
  const { getSiteUrl } = await import("@/lib/env");
  assert.throws(() => getSiteUrl(), /must use http or https/);
  restoreEnv();
});

test("getSiteUrl: returns a real URL object for a valid absolute URL", async () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://brawlranks.com";
  const { getSiteUrl } = await import("@/lib/env");
  const url = getSiteUrl();
  assert.equal(url.origin, "https://brawlranks.com");
  restoreEnv();
});
