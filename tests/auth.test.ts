import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyInternalCronBearer } from "@/lib/auth";

const ORIGINAL_SECRET = process.env.INTERNAL_CRON_SECRET;

function withSecret<T>(value: string | undefined, fn: () => T): T {
  if (value === undefined) delete process.env.INTERNAL_CRON_SECRET;
  else process.env.INTERNAL_CRON_SECRET = value;
  try {
    return fn();
  } finally {
    if (ORIGINAL_SECRET === undefined) delete process.env.INTERNAL_CRON_SECRET;
    else process.env.INTERNAL_CRON_SECRET = ORIGINAL_SECRET;
  }
}

test("auth: rejects when INTERNAL_CRON_SECRET is not configured", () => {
  withSecret(undefined, () => {
    const request = new Request("http://localhost/", { headers: { authorization: "Bearer whatever" } });
    const result = verifyInternalCronBearer(request);
    assert.equal(result.authorized, false);
    assert.equal(result.reason, "server_misconfigured");
  });
});

test("auth: rejects a missing authorization header", () => {
  withSecret("test-secret-value", () => {
    const request = new Request("http://localhost/");
    const result = verifyInternalCronBearer(request);
    assert.equal(result.authorized, false);
    assert.equal(result.reason, "missing_header");
  });
});

test("auth: rejects a malformed authorization header", () => {
  withSecret("test-secret-value", () => {
    const request = new Request("http://localhost/", { headers: { authorization: "Basic abc123" } });
    const result = verifyInternalCronBearer(request);
    assert.equal(result.authorized, false);
    assert.equal(result.reason, "malformed_header");
  });
});

test("auth: rejects an incorrect bearer secret", () => {
  withSecret("test-secret-value", () => {
    const request = new Request("http://localhost/", { headers: { authorization: "Bearer wrong-value" } });
    const result = verifyInternalCronBearer(request);
    assert.equal(result.authorized, false);
    assert.equal(result.reason, "invalid_secret");
  });
});

test("auth: accepts the correct bearer secret", () => {
  withSecret("test-secret-value", () => {
    const request = new Request("http://localhost/", { headers: { authorization: "Bearer test-secret-value" } });
    const result = verifyInternalCronBearer(request);
    assert.equal(result.authorized, true);
  });
});
