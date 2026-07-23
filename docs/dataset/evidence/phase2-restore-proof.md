# DATASET Phase 2 — restore-proof record

Secret-free record of the executed isolated restore proof. The backup
artifact, its checksum, and any connection credential are kept in the owner's
operational records **outside this repository** and are deliberately absent
here (mirrors the `restoreTest` block of the backup manifest, which
`assertNoSecrets()` keeps credential-free).

## Restore

| Field | Value |
|---|---|
| Source | Production Hostinger logical dump (`u350003894_brawl2`), owner-downloaded (~1.1 GB) |
| Isolated engine | MariaDB **11.8.8** (disposable local container) |
| Isolated database | `brawlranks_restoretest_20260719` |
| Restore tool | `scripts/dataset/restore-isolated.sh` (name/host/overwrite guards) |
| Executed | 2026-07-19 |
| Production writes | **none** — isolated copy only |

## Invariant validation — `validate-restored-db.sql`

Completed with **no FAIL verdict**. Recorded verdicts:

| Check | Result |
|---|---|
| target identity | PASS (`brawlranks_restoretest_%`) |
| migration count / checksums | 25 / 25, exact match to on-disk `migrations/*.sql` |
| table count | 47 (≥ 46 expected) — 45 migration + `schema_migrations` + `api_test_snapshots` |
| all critical tables present | PASS |
| non-InnoDB tables | 0 (all 47 InnoDB) |
| foreign keys | 73 (≥ 60 expected) |
| generated columns | 5 / 5 |
| `battle_key` unique index | PASS |
| current published snapshots | 1 |
| current published item count | 105 |
| current rule sets | 1 |
| unreleased workflow locks | 0 |
| orphan workflow steps | 0 |
| battle dedupe | 100,472 total / 100,472 distinct |
| orphan participants / teams / observations / aggregates / ranking results | 0 / 0 / 0 / 0 / 0 |
| secret/detail leak sweep (§14) | 0 |

Row counts recorded as restore evidence: normalized_battles 100,472;
battle_participants 782,785; battle_teams 438,102; battle_observations 141,354;
normalized_players 431,263; raw_api_snapshots 8,731; data_fetch_runs 13,003;
matchup_aggregates 1,029,646; ranking_results 17,208; matchup_results 108,876.

## Application smoke test — `scripts/dataset/smoke-restored-db.ts`

Read-only, executed 2026-07-19 against the restored copy through the **real**
public read path (`lib/publishedSnapshots/repository.ts` via
`lib/mysql.ts::getPool()`). No writes; no ingestion/aggregation/ranking/
retention/publication/migration invoked.

| Check | Result |
|---|---|
| connectivity (`SELECT 1`) | PASS |
| `getCurrentSnapshotMeta` | PASS (snapshot `dd68949f-1682-46f8-941e-cc9f39bc65d9`) |
| published brawlers non-empty | PASS (105) |
| item count = 105 | PASS |
| public contract shape (slug/tier/score/publishedAt on every item) | PASS |
| ordered by `overall_score` DESC | PASS |

## Sub-part status

- Backup artifact verification: **PASS**
- Isolated database restore: **PASS**
- Schema/data invariant validation: **PASS**
- Application/public-API smoke test: **PASS**
- Archived raw-object restore/replay: **now built and proven in Phase 4** — a
  real snapshot was archived and replayed: both SHA-256 hashes verified,
  decompressed, and the **existing** `validateBattleLogItems` validator ran in
  no-write mode (valid=1); source payload proven unchanged. The **one remaining
  sub-item** is running the full battle-graph **normalizer** in a dry-run mode
  (the existing normalizers are write-coupled with no no-write path). See
  `docs/dataset/phase4-raw-archive.md` → "Replay acceptance criterion".

## What this does and does not authorize

It closes the DATASET.md Phase 2 core restorability gate. It does **not**
authorize any production change, migration, deletion, timer change, secret
rotation, or infrastructure provisioning.
