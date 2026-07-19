# DATASET Phase 4 — raw API snapshot archival

Status: **implemented, repository-safe, and proven locally end-to-end.** Nothing
here removes, nulls, or is gated to remove any payload; no production timer is
enabled; no infrastructure is provisioned. Payload nulling and retention are a
separate, later, separately-approved work package (DATASET.md WP5/WP6).

## What was built

| Piece | File | Notes |
|---|---|---|
| Schema | `migrations/0026_create_raw_snapshot_archives.sql` | Companion table; does not touch `raw_api_snapshots`. Applies on MySQL 8.4 + MariaDB 11.8. |
| Deterministic keys | `lib/archive/keys.ts` | `raw/v1/YYYY/MM/DD/<cat>/<run>/<id>-<sum>.json.gz`; closed category mapping; strict UUID/SHA validation (no path injection). |
| Compression + hashing | `lib/archive/codec.ts` | gzip level 6; original SHA-256 (== `raw_api_snapshots.checksum`) + compressed-object SHA-256. |
| Provider abstraction | `lib/archive/provider.ts` | `ObjectStorageProvider` + `InMemory` and `LocalFilesystem` (tests/proof). `headObject` returns size only — never an ETag-as-SHA-256. |
| S3-compatible provider | `lib/archive/s3Provider.ts` | Self-contained AWS SigV4 (no SDK dependency); credentials only from env, never logged; `signV4` proven against the AWS test vector. |
| Queue repository | `lib/archive/repository.ts` | Copy-only enqueue (oldest-first, idempotent); `FOR UPDATE SKIP LOCKED` lease claim; verified/failed marks; metrics. Reads payload, never mutates it. |
| State machine | `lib/archive/service.ts` | claim+lease → verify original checksum → gzip → upload → HEAD → GET/decompress/verify → mark verified; capped exponential backoff; abandoned-lease recovery. |
| Replay | `lib/archive/replay.ts` | Read-only: download → verify both hashes → decompress → no-write validate; proves source payload unchanged. Takes the validator as a callback (no duplicated rules). |
| Replay validator adapter | `lib/archive/replayNormalizer.ts` | Dispatches by `endpoint_category` to the EXISTING ingestion validators (`validateBattleLogItems`, `validatePlayerPayload`, `validateClubPayload`, `validatePlayerRankingItems`, `validateBrawlersPayload`) in pure no-write mode. Duplicates no rules. |
| Cron route | `app/api/internal/cron/raw-snapshot-archive/route.ts` | Bearer-authed; bounded batch; copy-only; 503 until `ARCHIVE_S3_*` is configured. Uses the write-role pool. |

## State machine and invariants

```
pending ──claim(lease)──> uploading ──verify(HEAD+GET+both hashes)──> verified
   ^                          │
   └──── (lease expires, reclaimable) ────┘
            │
         failure → failed (last_error_code, next_attempt_at = capped backoff)
```

- **Idempotent claim / no double-processing:** `FOR UPDATE SKIP LOCKED` + a
  lease (`lease_owner`, `lease_expires_at`). A row leased by one worker is not
  re-claimed until its lease expires.
- **Abandoned-upload recovery:** an `uploading` row whose lease expired (worker
  died) is reclaimable. Justifies the two lease columns added beyond the
  DATASET.md draft.
- **Verification before success:** the object is verified by HEAD (size) then
  GET (re-hash compressed bytes AND decompress + re-hash original) before the
  row is marked `verified`.
- **Hard invariant — payload is never removed:** the worker only reads
  `raw_api_snapshots.payload`. No code path in this package nulls or deletes it.
- **Safe error codes only:** failures store an enumerated `last_error_code`
  (`upload_failed`, `head_size_mismatch`, `get_checksum_mismatch`,
  `decompressed_checksum_mismatch`, `original_checksum_mismatch`, …), never a
  raw error message that might carry detail.
- **Secrets:** S3 credentials come only from env and are never logged; error
  messages never include a secret, signature, or Authorization header.

## Local end-to-end proof

`scripts/dataset/archive-e2e-proof.ts`, run against a disposable
`brawlranks_archive_e2e` DB seeded with a **real** battle_log snapshot copied
from the restored production copy (no production connection):

```
source snapshot: 85652f2a-… (battle_log, 1268 bytes) → gzip 495 bytes (~39%)
key: raw/v1/2026/07/16/battle_log/d640f4b4-…/85652f2a-…-ed37e81d….json.gz
archived+verified: object 69f4421c… (495 bytes) on the local object store
replay: objectHashOk=true originalHashOk=true jsonParsed=true sourceUnchanged=true
replay validator (existing battle_log validator, no-write): valid=1 rejected=0
source payload unchanged: true    payload_removed_at: null (never removed)
PROOF PASSED
```

The replay step invokes the **existing** `validateBattleLogItems` (the same
function the live pipeline uses) in no-write mode — not a generic JSON check.

## Tests

| Test | Coverage | Runner |
|---|---|---|
| `tests/datasetArchive.test.ts` | 22 unit tests: deterministic key, path sanitization, gzip/hash correctness, in-memory/local providers, replay (all integrity failure modes), replay-validator adapter (existing-validator dispatch, envelope unwrap, unknown/zero-record rejection), SigV4 AWS vector, config resolution + secret-free errors, backoff. | `tsx --test` (no DB) |
| `tests/datasetArchiveRouteAuth.test.ts` | 4 tests: cron route rejects missing/wrong/query-string bearer with 401 before touching storage/DB; no stack-trace leak. | `tsx --test` (no DB) |
| `tests/datasetArchiveDbIntegration.test.ts` | 7 tests: copy-only enqueue + idempotency; verify + **payload still present**; upload-failure backoff; HEAD mismatch; GET mismatch; abandoned-lease recovery + duplicate-claim prevention; metrics. | `tsx --test` with a migrated DB (skips otherwise) |

All 33 pass on MySQL 8.4 (DB tests) / anywhere (unit tests). Migration 0026 also
proven on MariaDB 11.8.

## Replay acceptance criterion — exact status

DATASET.md requires replay to "verif[y] both hashes, decompress, and invoke the
existing validator/normalizer in dry-run or idempotent mode" (Phase 4), and the
Phase 2 restore proof to "restore one archived raw object, decompress it,
recompute SHA-256, and replay normalization without writes."

| Sub-criterion | Status |
|---|---|
| Resolve metadata, fetch by deterministic key | **PASS** |
| Verify compressed-object SHA-256 | **PASS** |
| Decompress + verify original payload SHA-256 | **PASS** |
| Invoke the **existing validator** in no-write (dry-run) mode | **PASS** — `validateBattleLogItems` ran in the E2E (valid=1, rejected=0); adapter dispatches every category to its existing validator, duplicating no rules. |
| Prove source payload unchanged | **PASS** |
| Invoke the full battle-graph **normalizer** (build battle/team/participant rows) in dry-run | **DEFERRED** — the existing normalizers are write-coupled and have no no-write mode; adding one is an ingestion-layer change outside this narrow archive package. This is the single remaining replay gap. |

So the archived-object **integrity replay + existing-validator dry-run** is
complete and proven; the only outstanding piece is running the full
normalization (battle-graph construction) without writes.

## Deferred / owner-gated (NOT done here, by design)

- **Full battle-graph normalizer dry-run** (the one remaining replay sub-item
  above): requires a no-write mode on the existing normalizers. Replay already
  accepts any validator/normalizer as a no-write callback, so this is a
  contained follow-up, not a redesign.
- Live DigitalOcean Spaces verification (needs owner-provisioned bucket +
  credentials). The SigV4 signer is proven against the AWS vector; a live PUT/
  HEAD/GET round-trip is the remaining owner step.
- Enabling any archive timer/cron schedule.
- Making `raw_api_snapshots.payload` nullable, and any payload nulling /
  retention integration — a separate, later, separately-approved package.
- The initial production backfill (copy-only, oldest-first) — run only after the
  above owner steps.
