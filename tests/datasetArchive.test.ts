/**
 * DATASET Phase 4 — archive library unit tests (no database required).
 *
 * Covers deterministic keys, path sanitization, gzip/hash correctness, the
 * in-memory/local providers, replay integrity (all failure modes), the S3
 * SigV4 signer (against the published AWS test vector), config resolution, and
 * the absence of secrets from errors. State-machine tests that need a real DB
 * live in tests/datasetArchiveDbIntegration.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  buildArchiveKey,
  safeEndpointSegment,
  listArchivableCategories,
  isValidUuid,
  isValidSha256,
} from "../lib/archive/keys";
import { gzipPayload, gunzipToString, sha256Hex } from "../lib/archive/codec";
import { InMemoryObjectStorage, LocalFilesystemObjectStorage, ObjectNotFoundError } from "../lib/archive/provider";
import { replayArchive, ReplayError, jsonStructuralValidator } from "../lib/archive/replay";
import { signV4, resolveS3Config, encodeRfc3986 } from "../lib/archive/s3Provider";
import { backoffSeconds, BASE_BACKOFF_SECONDS, MAX_BACKOFF_SECONDS } from "../lib/archive/service";

const UUID_A = "00087390-7510-4967-90d9-f14fc087b904";
const UUID_B = "11111111-2222-4333-8444-555555555555";
const SHA = "f5af991dc2c75be6b8aff8959616c33855cbf328cc818c4ea13e618c993a63dd";

// ---------------------------------------------------------------------------
// Keys and path sanitization
// ---------------------------------------------------------------------------

test("keys: deterministic key follows raw/v1/YYYY/MM/DD/<cat>/<run>/<id>-<sum>.json.gz", () => {
  const key = buildArchiveKey({
    snapshotId: UUID_A,
    dataFetchRunId: UUID_B,
    endpointCategory: "battle_log",
    checksum: SHA,
    receivedAt: new Date("2026-07-19T05:06:07.000Z"),
  });
  assert.equal(key, `raw/v1/2026/07/19/battle_log/${UUID_B}/${UUID_A}-${SHA}.json.gz`);
});

test("keys: same input always yields the same key (deterministic)", () => {
  const parts = { snapshotId: UUID_A, dataFetchRunId: UUID_B, endpointCategory: "player_profile", checksum: SHA, receivedAt: new Date("2026-01-02T00:00:00Z") };
  assert.equal(buildArchiveKey(parts), buildArchiveKey({ ...parts }));
});

test("keys: category is validated against a closed set (fail closed)", () => {
  assert.equal(safeEndpointSegment("battle_log"), "battle_log");
  assert.throws(() => safeEndpointSegment("../etc"), /Unarchivable endpoint_category/);
  assert.throws(() => safeEndpointSegment("unknown_cat"), /Unarchivable endpoint_category/);
  assert.deepEqual(
    [...listArchivableCategories()].sort(),
    ["battle_log", "brawlers_catalog", "club_profile", "player_profile", "player_rankings"]
  );
});

test("keys: non-UUID ids and bad checksums are rejected (no path injection)", () => {
  const good = { snapshotId: UUID_A, dataFetchRunId: UUID_B, endpointCategory: "battle_log", checksum: SHA, receivedAt: new Date() };
  assert.throws(() => buildArchiveKey({ ...good, snapshotId: "../../evil" }), /snapshotId is not a UUID/);
  assert.throws(() => buildArchiveKey({ ...good, dataFetchRunId: "x/y" }), /dataFetchRunId is not a UUID/);
  assert.throws(() => buildArchiveKey({ ...good, checksum: "short" }), /checksum is not a 64-hex/);
});

test("keys: validators", () => {
  assert.equal(isValidUuid(UUID_A), true);
  assert.equal(isValidUuid("nope"), false);
  assert.equal(isValidSha256(SHA), true);
  assert.equal(isValidSha256("zz"), false);
});

// ---------------------------------------------------------------------------
// Codec: gzip + dual SHA-256
// ---------------------------------------------------------------------------

test("codec: gzip round-trips and both checksums are correct", () => {
  const payload = JSON.stringify({ items: [1, 2, 3], name: "shelly" });
  const gz = gzipPayload(payload);
  assert.equal(gunzipToString(gz.compressed), payload);
  assert.equal(gz.originalChecksum, sha256Hex(Buffer.from(payload, "utf8")));
  assert.equal(gz.objectChecksum, sha256Hex(gz.compressed));
  assert.equal(gz.originalSize, Buffer.byteLength(payload, "utf8"));
  assert.equal(gz.objectSize, gz.compressed.byteLength);
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

test("provider(memory): put/head/get round-trip; missing object is null/throws", async () => {
  const p = new InMemoryObjectStorage();
  const body = Buffer.from("hello");
  await p.putObject({ bucket: "b", key: "k/1", body });
  assert.deepEqual(await p.headObject("b", "k/1"), { size: 5 });
  assert.deepEqual(await p.getObject("b", "k/1"), body);
  assert.equal(await p.headObject("b", "missing"), null);
  await assert.rejects(() => p.getObject("b", "missing"), ObjectNotFoundError);
});

test("provider(local-fs): rejects a key that escapes the bucket root", async () => {
  const p = new LocalFilesystemObjectStorage("/tmp/archive-root");
  await assert.rejects(() => p.getObject("b", "../../etc/passwd"), /escapes bucket root/);
});

// ---------------------------------------------------------------------------
// Replay (stubbed DB) — every integrity failure mode
// ---------------------------------------------------------------------------

/** Minimal Queryable stub returning canned archive + raw rows. */
function stubDb(archiveRow: Record<string, unknown> | null, rawRow: Record<string, unknown> | null) {
  return {
    query: async (sql: string) => {
      if (/FROM raw_snapshot_archives/i.test(sql)) return [archiveRow ? [archiveRow] : []];
      if (/FROM raw_api_snapshots/i.test(sql)) return [rawRow ? [rawRow] : []];
      return [[]];
    },
  } as any;
}

async function seedVerified(provider: InMemoryObjectStorage, payload: string, bucket = "b") {
  const gz = gzipPayload(payload);
  const key = `raw/v1/2026/07/19/battle_log/${UUID_B}/${UUID_A}-${gz.originalChecksum}.json.gz`;
  await provider.putObject({ bucket, key, body: gz.compressed });
  const archiveRow = {
    raw_snapshot_id: UUID_A, object_provider: "memory", object_bucket: bucket, object_key: key,
    compression: "gzip", original_size_bytes: gz.originalSize, object_size_bytes: gz.objectSize,
    original_checksum: gz.originalChecksum, object_checksum: gz.objectChecksum,
    archive_status: "verified", attempt_count: 1, payload_removed_at: null,
  };
  const rawRow = { payload, checksum: gz.originalChecksum };
  return { gz, key, archiveRow, rawRow };
}

test("replay: success verifies both hashes, proves source unchanged, runs validator", async () => {
  const provider = new InMemoryObjectStorage();
  const payload = JSON.stringify({ ok: true, items: [1] });
  const { archiveRow, rawRow } = await seedVerified(provider, payload);
  let sawPayload: unknown;
  const report = await replayArchive(stubDb(archiveRow, rawRow), provider, UUID_A, {
    validate: (p) => { sawPayload = p; },
  });
  assert.equal(report.ok, true);
  assert.equal(report.objectChecksumOk, true);
  assert.equal(report.originalChecksumOk, true);
  assert.equal(report.sourcePayloadUnchanged, true);
  assert.deepEqual(sawPayload, { ok: true, items: [1] });
});

test("replay: corrupted object bytes -> object_checksum_mismatch", async () => {
  const provider = new InMemoryObjectStorage();
  const { archiveRow, rawRow, key } = await seedVerified(provider, JSON.stringify({ a: 1 }));
  provider.corrupt("b", key, Buffer.from("not the object"));
  await assert.rejects(
    () => replayArchive(stubDb(archiveRow, rawRow), provider, UUID_A),
    (e: ReplayError) => e.code === "object_checksum_mismatch"
  );
});

test("replay: object that is not gzip -> object checksum still guards, then decompress fails", async () => {
  const provider = new InMemoryObjectStorage();
  const notGzip = Buffer.from("plain text, not gzip");
  const key = `raw/v1/2026/07/19/battle_log/${UUID_B}/${UUID_A}-${SHA}.json.gz`;
  await provider.putObject({ bucket: "b", key, body: notGzip });
  const archiveRow = {
    raw_snapshot_id: UUID_A, object_provider: "memory", object_bucket: "b", object_key: key,
    compression: "gzip", original_size_bytes: 1, object_size_bytes: notGzip.byteLength,
    original_checksum: SHA, object_checksum: sha256Hex(notGzip),
    archive_status: "verified", attempt_count: 1, payload_removed_at: null,
  };
  await assert.rejects(
    () => replayArchive(stubDb(archiveRow, { payload: "x", checksum: SHA }), provider, UUID_A),
    (e: ReplayError) => e.code === "decompress_failed"
  );
});

test("replay: decompressed payload with wrong original checksum -> original_checksum_mismatch", async () => {
  const provider = new InMemoryObjectStorage();
  const payload = JSON.stringify({ a: 1 });
  const good = gzipSync(Buffer.from(payload));
  const key = `raw/v1/2026/07/19/battle_log/${UUID_B}/${UUID_A}-${SHA}.json.gz`;
  await provider.putObject({ bucket: "b", key, body: good });
  const archiveRow = {
    raw_snapshot_id: UUID_A, object_provider: "memory", object_bucket: "b", object_key: key,
    compression: "gzip", original_size_bytes: payload.length, object_size_bytes: good.byteLength,
    original_checksum: "a".repeat(64), object_checksum: sha256Hex(good),
    archive_status: "verified", attempt_count: 1, payload_removed_at: null,
  };
  await assert.rejects(
    () => replayArchive(stubDb(archiveRow, { payload, checksum: "a".repeat(64) }), provider, UUID_A),
    (e: ReplayError) => e.code === "original_checksum_mismatch"
  );
});

test("replay: source payload changed since archive -> source_payload_changed", async () => {
  const provider = new InMemoryObjectStorage();
  const payload = JSON.stringify({ a: 1 });
  const { archiveRow } = await seedVerified(provider, payload);
  // Source now has a DIFFERENT payload/checksum than archived.
  const changedRaw = { payload: JSON.stringify({ a: 2 }), checksum: "b".repeat(64) };
  await assert.rejects(
    () => replayArchive(stubDb(archiveRow, changedRaw), provider, UUID_A),
    (e: ReplayError) => e.code === "source_payload_changed"
  );
});

test("replay: missing archive row and unverified row are rejected", async () => {
  const provider = new InMemoryObjectStorage();
  await assert.rejects(
    () => replayArchive(stubDb(null, null), provider, UUID_A),
    (e: ReplayError) => e.code === "archive_row_missing"
  );
  const unverified = {
    raw_snapshot_id: UUID_A, object_provider: "memory", object_bucket: "b", object_key: "k",
    compression: "gzip", original_size_bytes: 1, object_size_bytes: null,
    original_checksum: SHA, object_checksum: null, archive_status: "pending", attempt_count: 0, payload_removed_at: null,
  };
  await assert.rejects(
    () => replayArchive(stubDb(unverified, null), provider, UUID_A),
    (e: ReplayError) => e.code === "not_verified"
  );
});

test("replay: default validator rejects non-object payloads", () => {
  assert.throws(() => jsonStructuralValidator(42, { rawSnapshotId: UUID_A }), /not a JSON object/);
  assert.doesNotThrow(() => jsonStructuralValidator({ a: 1 }, { rawSnapshotId: UUID_A }));
});

// ---------------------------------------------------------------------------
// S3 SigV4 signer — proven against the published AWS test vector
// ---------------------------------------------------------------------------

test("s3: signV4 matches the AWS SigV4 'get-vanilla' test vector", () => {
  const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const result = signV4({
    method: "GET",
    host: "example.amazonaws.com",
    canonicalUri: "/",
    headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
    payloadHash: EMPTY_SHA,
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
    amzDate: "20150830T123600Z",
  });
  assert.equal(result.signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.equal(result.signedHeaders, "host;x-amz-date");
  assert.equal(result.credentialScope, "20150830/us-east-1/service/aws4_request");
  assert.match(result.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request/);
});

test("s3: encodeRfc3986 encodes reserved chars but can keep slashes", () => {
  assert.equal(encodeRfc3986("a b/c"), "a%20b%2Fc");
  assert.equal(encodeRfc3986("a b/c", false), "a%20b/c");
});

test("s3: resolveS3Config is null when unset, throws (no secret) on partial config", () => {
  assert.equal(resolveS3Config({}), null);
  assert.throws(
    () => resolveS3Config({ ARCHIVE_S3_ENDPOINT: "https://x", ARCHIVE_S3_SECRET_ACCESS_KEY: "TOPSECRET" }),
    (e: Error) => {
      assert.match(e.message, /ARCHIVE_S3_REGION/);
      assert.ok(!e.message.includes("TOPSECRET"), "error must not leak the secret");
      return true;
    }
  );
  const cfg = resolveS3Config({
    ARCHIVE_S3_ENDPOINT: "https://fra1.digitaloceanspaces.com",
    ARCHIVE_S3_REGION: "fra1",
    ARCHIVE_S3_BUCKET: "brawl-archive",
    ARCHIVE_S3_ACCESS_KEY_ID: "AKID",
    ARCHIVE_S3_SECRET_ACCESS_KEY: "sek",
  });
  assert.equal(cfg?.bucket, "brawl-archive");
  assert.equal(cfg?.forcePathStyle, true);
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

test("service: backoff is exponential and capped", () => {
  assert.equal(backoffSeconds(1), BASE_BACKOFF_SECONDS);
  assert.equal(backoffSeconds(2), BASE_BACKOFF_SECONDS * 2);
  assert.equal(backoffSeconds(3), BASE_BACKOFF_SECONDS * 4);
  assert.ok(backoffSeconds(20) <= MAX_BACKOFF_SECONDS);
  assert.equal(backoffSeconds(99), MAX_BACKOFF_SECONDS);
});
