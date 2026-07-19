# DATASET Phase 3 — MySQL 8.4 compatibility

Status: **compatibility gate PASSED on a real MySQL 8.4 server.** The single
blocker (`battle_teams.rank`) is resolved backward-compatibly, all 25
migrations apply cleanly from empty on MySQL 8.4.10, and the runtime semantics
the schema depends on behave identically.

This closes the compatibility precondition on DATASET.md's DigitalOcean Managed
MySQL 8.4 recommendation. It does **not** authorize provisioning — see the
provisioning checklist below, which is a plan only.

## The blocker and its fix

`RANK` became a reserved word in MySQL 8.0 (window functions). MariaDB accepts
it unquoted, so production (MariaDB) never surfaced it, but
`migrations/0014_create_battle_tables.sql` declared `rank INT NULL` unquoted and
that CREATE TABLE is a **syntax error on MySQL 8.4**.

**Fix:** backtick-quote the column — `` `rank` INT NULL ``. Backticks are
purely lexical; the resulting `battle_teams` column is byte-identical on both
engines. No column was renamed, so no application code changes.

### Backward-compatibility with existing production MariaDB

Editing `0014` changes its SHA-256, and `scripts/migrate.mjs` refuses checksum
drift on an already-applied migration — which would block future migrations on
the live MariaDB database that recorded the pre-edit checksum. A CREATE-TABLE
syntax error in an early migration cannot be fixed by a *later* migration
(0014 fails to parse before any later file runs), so the edit is unavoidable.

It is reconciled **without any production write** by an explicit, narrow
allowlist in `scripts/migrate.mjs`:

```js
const ACCEPTED_PRIOR_CHECKSUMS = {
  "0014": new Set([
    "aab4acd247747216c2a56ad2396d0c724d7fb74df02ba8b4fc36b075a4272302", // pre-quote
  ]),
};
```

- old (production/MariaDB) checksum: `aab4acd2…4272302`
- new (backtick-quoted) checksum:     `7dedfae4…a92f13e3`

When a `schema_migrations` row records the allowlisted prior checksum, the
runner treats it as a **reviewed, schema-preserving supersession**, not drift —
and logs a note. Every other mismatch still aborts. The guard is not weakened
for anything outside this one reviewed pair. No production row is updated; the
old recorded checksum may remain indefinitely.

This satisfies the DATASET.md rule "never edit an applied migration checksum
silently": the edit is explicit, documented, allowlisted, and test-covered
(`tests/datasetMysql84Compat.test.ts`).

## Proof on a real MySQL 8.4 server

Reproducible via `scripts/dataset/mysql84-compat-test.mjs` against a disposable
`mysql:8.4` container (created per DATASET.md Phase 6.1: `utf8mb4` /
`utf8mb4_unicode_ci`, `time_zone=+00:00`). Executed 2026-07-19 against
**MySQL 8.4.10**.

### Migrations from empty

`node scripts/migrate.mjs up` applied all **25** migrations with no error.
Resulting schema matches production exactly:

| Check | Result |
|---|---|
| migrations applied | 25 |
| tables | 46 (45 migration + `schema_migrations`) |
| non-InnoDB tables | 0 |
| table collations | all `utf8mb4_unicode_ci` |
| foreign keys | 73 |
| generated columns | 5 |
| CHECK constraints | 36 |
| `battle_teams.rank` | present (`int`) |
| active rule set (post-seed 0025) | 1 |

### Runtime semantics (all PASS on 8.4)

| Behavior | Result on MySQL 8.4.10 |
|---|---|
| Generated-column single-current invariant (`IF(cond,1,NULL)` STORED + `UNIQUE`) | NULL slots repeat; a second active row is rejected with `ER_DUP_ENTRY` (1062). Identical to MariaDB. |
| CHECK constraint enforcement | Invalid value rejected with errno **3819**. |
| `INSERT … ON DUPLICATE KEY UPDATE` | Upsert arithmetic correct (`n=1+5=6`). |
| Advisory locks (`GET_LOCK`/`RELEASE_LOCK`) | acquired=1, released=1 (migration runner's serialization primitive). |
| `SELECT … FOR UPDATE SKIP LOCKED` | Supported; returns the unlocked row (used by crawl fairness). |
| `DATETIME(3)` | Millisecond precision preserved round-trip. |

### Server-mode differences observed (reconciled)

- `@@sql_mode` on MySQL 8.4 includes `ONLY_FULL_GROUP_BY` and
  `NO_ZERO_IN_DATE`/`NO_ZERO_DATE` (MariaDB's default omits `ONLY_FULL_GROUP_BY`).
  The migrations and seed apply cleanly under it. Aggregation/ranking queries
  must be re-run against 8.4 during Phase 6 benchmarking to confirm none rely on
  non-grouped column selection; the schema itself is unaffected.
- `@@collation_server` on the source MariaDB is `utf8mb4_uca1400_ai_ci`
  (MariaDB-only) but **unused** — every table declares `utf8mb4_unicode_ci`,
  which exists on 8.4 and is what the target must default to (not MySQL's
  `utf8mb4_0900_ai_ci`).
- `time_zone` must be `+00:00` on the target; `NOW(3)`/`UTC_TIMESTAMP(3)` writes
  are UTC-based and `DATETIME` is timezone-independent.

### Confirmed portable (unchanged from static analysis)

- JSON-shaped columns are `LONGTEXT`, never native `JSON` — identical on 8.4.
- UUID PKs are `CHAR(36)` text — no `BINARY(16)` semantics to port.
- No declared index exceeds the 3072-byte InnoDB DYNAMIC limit.

## What was NOT changed

- No constraint was weakened to obtain a green result.
- No column was renamed or dropped.
- No production database was touched; all work was on disposable containers.
- The migration runner's drift guard still rejects all non-allowlisted drift.

## Automated tests

| Test | Type | Runner |
|---|---|---|
| `tests/datasetMysql84Compat.test.ts` | unit (no DB): 0 static blockers, `rank` quoted, checksum allowlist correctness, reconciliation accept/reject logic | `tsx --test` |
| `scripts/dataset/mysql84-compat-test.mjs` | integration: real MySQL 8.4 container, migrations from empty + runtime semantics | disposable `mysql:8.4` |

## Provisioning checklist — DigitalOcean Managed MySQL 8.4 (PLAN ONLY, do not provision)

Nothing here authorizes purchase or provisioning. Each item is an owner
decision to be made at approval time.

| Item | Decision to confirm |
|---|---|
| MySQL version | 8.4 LTS (compatibility proven above). |
| Region | Closest to the DO collector/proxy region to minimize write latency. |
| Storage | ≥ 100 GiB usable at launch; 200 GiB 12-month target; never launch with < 30 days forecast headroom. |
| Standby / HA | Standard Edition **with one standby** (primary+standby). |
| PITR / backups | Managed 7-day PITR as a second layer; portable encrypted logical dumps remain primary. Second encrypted copy outside DigitalOcean. |
| Trusted sources | Allowlist DO workloads (private network) + Hostinger stable outbound IP(s). If Hostinger has no stable IP, a narrowly-scoped DO ProxySQL/HAProxy front — never `0.0.0.0/0`. |
| TLS / CA | Require TLS; pin the provider CA. Configure `READ_DB_CA_PATH`/`WRITE_DB_CA_PATH` (see role config). |
| Server params | `character_set_server=utf8mb4`, `collation_server=utf8mb4_unicode_ci`, `time_zone=+00:00`, strict mode; reconcile `sql_mode` (`ONLY_FULL_GROUP_BY`) in staging. `lower_case_table_names` set consistently at init (cannot change later). |
| User roles | Least-privilege `app_read`, `ingest_write`, `workflow_write`, `migration_admin`, `backup_read`. Admin/migration creds never used by the app. |
| Connection budget | App pools start at 2 per process/role; total processes × pool size < 60% of provider `max_connections` (no provider-side MySQL pooling on DO). |
| Monitoring | Size, growth, days-to-limit, connection usage, slow queries, replication lag, backup/restore-test age (Phase 15 metric set). |
| Rollback | Keep Hostinger authoritative and writable; discard/recreate the target on any failure. No source data is deleted by staging. |
