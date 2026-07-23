/**
 * DATASET — WRITE database TLS CA support (getWritePool()).
 *
 * Proves the fix for the production HANDSHAKE_SSL_ERROR ("self signed
 * certificate in certificate chain"): when WRITE_DB_SSL=true and
 * WRITE_DB_CA_PATH is set, the writer pool's mysql2 `ssl` option carries the
 * explicit CA file contents with rejectUnauthorized=true — the legacy and read
 * pools are untouched, and a misconfigured CA path fails loudly (never silently
 * disabling verification, never leaking secrets/cert contents).
 *
 * These tests touch the filesystem (a temporary CA file) but never open a DB
 * connection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRoleSslOptions } from "../lib/mysql";

const WRITE_SECRET = "write-secret-do-not-leak-ABC";
const CA_CONTENT = "-----BEGIN CERTIFICATE-----\nMIITESTdummycacontentnotarealcert==\n-----END CERTIFICATE-----\n";

function tmpCaFile(content = CA_CONTENT): { caPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "write-db-ca-"));
  const caPath = path.join(dir, "ca-certificate.crt");
  writeFileSync(caPath, content, "utf8");
  return { caPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeRoleEnv(caPath?: string, reject?: string): Record<string, string> {
  return {
    // Legacy (must remain untouched)
    DB_HOST: "legacy.example",
    DB_NAME: "brawl_legacy",
    DB_USER: "legacy_user",
    BRAWL_DB_SECRET_V1: "legacy-secret",
    // Write role — mirrors the production Hostinger runtime
    WRITE_DB_HOST: "writer.do",
    WRITE_DB_NAME: "brawl_rw",
    WRITE_DB_USER: "ingest_write",
    WRITE_DB_SECRET: WRITE_SECRET,
    WRITE_DB_SSL: "true",
    ...(caPath ? { WRITE_DB_CA_PATH: caPath } : {}),
    ...(reject ? { WRITE_DB_SSL_REJECT_UNAUTHORIZED: reject } : {}),
  };
}

const asObj = (ssl: unknown): { ca?: string; rejectUnauthorized?: boolean } => ssl as { ca?: string; rejectUnauthorized?: boolean };

test("write CA: writer pool receives the explicit CA file contents with rejectUnauthorized=true", () => {
  const { caPath, cleanup } = tmpCaFile();
  try {
    const ssl = resolveRoleSslOptions("write", writeRoleEnv(caPath));
    assert.ok(ssl && typeof ssl === "object", "writer must have an ssl object");
    assert.equal(asObj(ssl).ca, CA_CONTENT, "writer ssl.ca must be the CA file contents (explicit CA), not undefined");
    assert.equal(asObj(ssl).rejectUnauthorized, true, "verification stays on");
  } finally {
    cleanup();
  }
});

test("write CA: WRITE_DB_SSL_REJECT_UNAUTHORIZED parsing is preserved (only 'false' disables; default true)", () => {
  const { caPath, cleanup } = tmpCaFile();
  try {
    assert.equal(asObj(resolveRoleSslOptions("write", writeRoleEnv(caPath, "true"))).rejectUnauthorized, true);
    assert.equal(asObj(resolveRoleSslOptions("write", writeRoleEnv(caPath))).rejectUnauthorized, true, "defaults to true");
    // Explicit opt-out is still honored (and still ships the CA), but this fix never sets it.
    assert.equal(asObj(resolveRoleSslOptions("write", writeRoleEnv(caPath, "FALSE"))).rejectUnauthorized, false);
    assert.equal(asObj(resolveRoleSslOptions("write", writeRoleEnv(caPath, "FALSE"))).ca, CA_CONTENT);
  } finally {
    cleanup();
  }
});

test("write CA: legacy and read pools are unaffected — no CA is read and ssl is undefined", () => {
  const { caPath, cleanup } = tmpCaFile();
  try {
    // Only WRITE_DB_* role vars are set; the read role falls back to legacy.
    const env = writeRoleEnv(caPath);
    assert.equal(resolveRoleSslOptions("read", env), undefined, "read role stays legacy -> no TLS, no CA read");

    // Legacy-only env: both roles legacy, neither builds any ssl.
    const legacyOnly = { DB_HOST: "l", DB_NAME: "n", DB_USER: "u", BRAWL_DB_SECRET_V1: "p" };
    assert.equal(resolveRoleSslOptions("write", legacyOnly), undefined, "legacy write pool unchanged (no ssl)");
    assert.equal(resolveRoleSslOptions("read", legacyOnly), undefined, "legacy read pool unchanged (no ssl)");
  } finally {
    cleanup();
  }
});

test("write CA: a configured-but-unreadable CA path fails clearly, keeps verification on, and leaks no secret/cert", () => {
  const missingPath = path.join(os.tmpdir(), `write-db-ca-missing-${Date.now()}-${Math.random().toString(36).slice(2)}.crt`);
  assert.throws(
    () => resolveRoleSslOptions("write", writeRoleEnv(missingPath)),
    (err: Error) => {
      assert.match(err.message, /WRITE_DB_CA_PATH/, "error must name the write CA variable");
      assert.match(err.message, /NOT disabled/i, "error must state verification is not disabled");
      assert.ok(!err.message.includes(WRITE_SECRET), "error must not contain the write secret");
      assert.ok(!err.message.includes(CA_CONTENT), "error must not contain certificate contents");
      return true;
    }
  );
});

test("write CA: an empty CA file fails clearly rather than shipping an empty ca to mysql2", () => {
  const { caPath, cleanup } = tmpCaFile("   \n  ");
  try {
    assert.throws(
      () => resolveRoleSslOptions("write", writeRoleEnv(caPath)),
      (err: Error) => {
        assert.match(err.message, /WRITE_DB_CA_PATH/);
        assert.match(err.message, /empty/i);
        return true;
      }
    );
  } finally {
    cleanup();
  }
});
