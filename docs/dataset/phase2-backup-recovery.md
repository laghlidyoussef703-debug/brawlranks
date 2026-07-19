# DATASET Phase 2 — backup and recovery

Phase 2 has several parts with **different statuses that must not be reported as one**.

| Part | Status | Basis |
|---|---|---|
| **A. Repository tooling and documentation** | **DONE** | Five scripts + two documents + safety tests, all in this repository. |
| **B1. Backup artifact verification** | **PASS** | A production Hostinger backup (~1.1 GB) was downloaded and successfully consumed by the restore; a corrupt/incomplete dump would have failed the load. |
| **B2. Isolated database restore** | **PASS** | Restored into disposable `brawlranks_restoretest_20260719` (MariaDB 11.8), name-guarded by `restore-isolated.sh`. |
| **B3. Schema/data invariant validation** | **PASS** | `validate-restored-db.sql` completed with **no FAIL verdict** (identity, 25/25 checksums, 47 tables, 73 FKs, 5/5 generated columns, dedupe 100,472=100,472, all orphan classes 0, one current snapshot of 105 items, secret sweep 0). |
| **B4. Application/public-API smoke test** | **PASS** | The real public read path (`lib/publishedSnapshots/repository.ts` via `getPool()`) served the current snapshot with 105 correctly-shaped, score-ordered items — read-only. See `scripts/dataset/smoke-restored-db.ts`. |
| **B5. Archived raw-object restore/replay** | **MOSTLY MET (one item deferred)** | Built and proven in Phase 4: a real snapshot was archived and replayed — both SHA-256 hashes verified, decompressed, the **existing** `validateBattleLogItems` validator run in no-write mode (valid=1), and the source payload proven unchanged. The single remaining sub-item is running the full battle-graph **normalizer** in dry-run (existing normalizers are write-coupled). |

> **The core restorability gate is MET.** An isolated restore of a
> production-derived backup passed `validate-restored-db.sql` with no FAIL and
> passed a read-only application smoke test. Phase 4 has since built and proven
> the archived raw-object replay path (B5): integrity replay + existing-
> validator dry-run PASS; the **only** outstanding sub-item is running the full
> battle-graph normalizer in a no-write mode (the existing normalizers are
> write-coupled). Restore-proof evidence is in
> `docs/dataset/evidence/phase2-restore-proof.md`; the replay acceptance
> breakdown is in `docs/dataset/phase4-raw-archive.md`.
>
> This is production-**derived**, restored-copy evidence — not a live mutable
> production query, and not authorization for any production change.

## 1. Backup artifact discovery — result

Searched, on 2026-07-18, in the expected local artifact locations only (`~/Downloads`, `~/Desktop`, non-recursive beyond depth 2), by filename pattern: `*.sql`, `*.sql.gz`, `*dump*`, `*backup*`, `*u350003894*`, `*brawl2*`.

**Result: no database backup artifact exists on this workstation.**

- The only pattern match was `~/Desktop/royalecoach_backup_now`, a zero-byte file from 2026-06-06 belonging to an unrelated project.
- No file in `~/Downloads` dated 2026-07-17 or later is anything other than a PNG image.
- No file of any plausible dump size exists anywhere in the searched locations.

**[PROD]** Hostinger reported "Database backup prepared for download — Completed" for the custom backup created 2026-07-18 06:58 against `u350003894_brawl2`, alongside three automatic copies (2026-07-17 17:17, 2026-07-16 17:17, 2026-07-15 17:16).

**"Prepared for download" is not "downloaded."** Hostinger generated the artifact on its own infrastructure and made it available. Nothing has retrieved it. The artifact does not exist outside Hostinger, which means:

- there is currently **no backup copy independent of the Hostinger account** — DATASET.md Phase 0 entry criterion 3 is **not met**;
- the 3-2-1 property does not hold: a Hostinger account incident would take the database and every backup of it simultaneously;
- no checksum, size, or format is known, so none can honestly be recorded.

### Environment capability check

| Capability | Present | Consequence |
|---|---|---|
| `docker` | **No** | Cannot spin up a disposable MariaDB or MySQL 8.4 container. |
| `mysql` / `mariadb` client | **No** | Cannot connect to or load a dump into any database. |
| `mysqldump` / `mariadb-dump` | **No** | Cannot produce or re-dump. |
| `gzip`, `sha256sum`, `node`, `npm`, `bash` | Yes | Verification tooling runs; restore tooling cannot. |

Even if the artifact were downloaded right now, **the restore could not be executed here.** Both blockers must be cleared.

## 2. Backup design (recommendation — not yet implemented)

Per DATASET.md Phase 2, unchanged and restated for the operator:

- Nightly transaction-consistent logical dump (schema + data); weekly independent full dump; schema-only dump on every deployment; weekly data-only dump so schema and data restore independently.
- Use the client matching the **source** engine with `--single-transaction --quick --hex-blob --routines --triggers --events --default-character-set=utf8mb4`. Never `--lock-all-tables` — it would stall collectors and public reads.
- Encrypt before upload (`age` or KMS envelope). Write-only credentials for backup; separate credentials for restore.
- Retention: 7 daily, 5 weekly, 12 monthly, 7 annual. Pre-migration and pre-cutover backups ≥13 months.
- Record SHA-256 of both ciphertext and plaintext, plus an immutable manifest. Keep one copy with a different provider.
- Managed PITR is a second layer, never a replacement for portable dumps.

**On shared hosting the operator may not be able to run `mysqldump` at all.** In that case the Hostinger panel export is the only available logical dump, and the tooling below is built to work with whatever that panel produces.

## 3. Tooling delivered

| Script | Purpose | Safety contract |
|---|---|---|
| `scripts/dataset/verify-backup.mjs` | Streams a dump; reports size, SHA-256, container format, gzip integrity over the full stream, presence of the 46 expected tables, detected database name and source engine, DEFINER clauses, routines/triggers/events, charset/collation, MariaDB-only syntax, and embedded-credential risk. | Never connects to a database. Never modifies the artifact. **Never prints matched credential text** — only a boolean. |
| `scripts/dataset/create-backup-manifest.mjs` | Builds the immutable manifest. `--template` emits a fill-in template when no artifact exists. | `assertNoSecrets()` **fails closed**: refuses to write if any field is a connection string, inline password, forbidden key (`password`, `secret`, `token`, `db_host`, `host`, …), or an opaque long token. SHA-256 fields are explicitly exempted. `restoreTest.status` is hardcoded `NOT_PERFORMED` and is never auto-filled. |
| `scripts/dataset/restore-isolated.sh` | Restores into a disposable database and cleans it up. | Six fail-closed guards — see below. |
| `scripts/dataset/validate-restored-db.sql` | 14-section validation suite: migration ledger and checksums, table/critical-table presence, engine/collation, FK and generated-column survival, `battle_key` unique-index survival, publication integrity, config invariants, workflow/lock sanity, row counts, timestamp bounds, dedup proof, five orphan classes, representative read queries mirroring the real public repository, and a secret-leakage sweep. | SELECT-only. Section 0 refuses to certify a target whose name lacks the disposable prefix. |
| `scripts/dataset/compatibility-check.mjs` | Static MariaDB → MySQL 8.4 inspection. | Refuses to claim runtime verification; every finding is labelled static-only. |

### restore-isolated.sh guards

1. Target must match `^brawlranks_restoretest_`.
2. Target must not contain a production marker (`u350003894`, `brawl2`, `prod`, `production`, `live`, `main`) **after** the prefix is stripped — so the prefix cannot be used as a bypass.
3. Host must be loopback unless `ALLOW_REMOTE_TARGET=1` is explicitly exported.
4. Refuses to overwrite an existing database that already contains tables.
5. Requires the operator to type the target name back (unless `--assume-yes`).
6. **Never expands `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PORT`, or `BRAWL_DB_SECRET_V1`** — a stray production environment cannot become the target. Enforced by test.

Additionally: the dump is opened read-only and never written back; `--force` is deliberately not passed to the client, so a failing statement stops the restore rather than producing a silently partial one.

All six behaviors are covered by executing tests in `tests/datasetToolingSafety.test.ts` — the guards are proven by running the script with hostile arguments, not by reading it.

## 4. Backup validation — what can and cannot be checked

**Checkable now, with no database:** archive integrity, gzip decompression over the full stream, SQL readability, expected table names, DEFINER clauses, routines/triggers/events, charset and collation, MariaDB-specific syntax, embedded credentials, size, SHA-256.

**Not checkable without a restore:** that the dump actually loads, that FKs and generated columns survive, that row counts match the source, that publication integrity holds, that the application can read it.

The first list is what `verify-backup.mjs` does. The second list is what `validate-restored-db.sql` does, and **it is the list that matters** — DATASET.md is explicit that "a backup is not complete until this proof succeeds."

## 5. MariaDB → MySQL 8.4 compatibility

`node scripts/dataset/compatibility-check.mjs` — static inspection only, run 2026-07-18.

### BLOCKER (1)

**`battle_teams.rank` is an unquoted reserved word.** `migrations/0014_create_battle_tables.sql:68` declares:

```sql
  rank INT NULL,
```

`RANK` became a reserved keyword in MySQL 8.0 (window functions). MariaDB accepts it unquoted, which is why this has never surfaced. **Applying migration 0014 to MySQL 8.4 will fail with a syntax error**, so DATASET.md Phase 6 step 3 ("apply 0001 through current on an empty staging DB") cannot succeed as written.

This is a real, previously unrecorded finding, and it directly conditions DATASET.md's Phase 3 recommendation — which already states the DigitalOcean MySQL 8.4 choice is "conditional on Phase 6 proving all migrations and queries on MySQL 8.4," with AWS RDS MariaDB as the fallback.

Resolution options, none actionable in this phase:

- **Do not edit migration 0014.** `scripts/migrate.mjs` refuses checksum drift on an applied migration, so editing it would break every existing environment.
- A forward migration renaming the column would change an application-facing column name and needs code changes and its own gate.
- The pragmatic route is a documented, reviewed transformation applied to the dump/DDL at migration time — which makes the target's schema differ textually from the repository's migrations, and that divergence must be explicitly accepted and recorded.
- Or select the AWS RDS MariaDB fallback, where the issue does not arise.

**This decision belongs to the owner and is out of Phase 1/2 scope.**

### Needs staging verification (11)

Generated columns (5 instances of the `IF(...)` NULL-slot pattern), 36 CHECK constraints (MariaDB evaluates over-long values against the CHECK *before* truncation — `migrations/0016` is direct evidence; MySQL 8.4 may raise a different error code), `@@sql_mode` differences (MySQL 8.4 enables `ONLY_FULL_GROUP_BY` by default), `time_zone` (must be `+00:00`; `NOW(3)` is session-dependent), `GET_LOCK` semantics changes in MySQL 8.0+, `SKIP LOCKED` (confirmed in use at `lib/ingestion/repository.ts:478` and in `lib/ingestion/fairness.ts`), `lower_case_table_names`, DEFINER handling, and the non-atomic multi-DDL migration property.

### Confirmed portable (3)

- **JSON:** all JSON-shaped columns are `LONGTEXT`, never native `JSON` — deliberate per `migrations/0004`, and it makes the schema *more* portable, not less.
- **UUID storage:** `CHAR(36)` text throughout; no `BINARY(16)`/`UUID_TO_BIN` semantics to port.
- **Index length:** no declared index exceeds the 3072-byte InnoDB DYNAMIC limit even under a worst-case 4-bytes-per-character utf8mb4 assumption.

**None of this is runtime-verified.** Static inspection cannot close the Phase 6 gate.

## 6. Isolated restore environment (prepared, not executed)

Preferred order per DATASET.md, with what is achievable:

1. **Local disposable MariaDB matching Hostinger** — requires Docker or a local MariaDB. Neither is installed. **Recommended once Docker is available**, because it matches the source engine and isolates the restore from the MySQL 8.4 question.
2. **Approved temporary/staging database** — requires owner provisioning approval. Not requested here (DATASET.md forbids provisioning in this phase).
3. **Containerized compatibility matrix** — restore into both a MariaDB container and a MySQL 8.4 container to settle section 5's open items in one exercise. This is the highest-value option and becomes available the moment Docker is installed.

Exact commands are in `docs/dataset/restore-runbook.md`.

## 7. Application-level smoke test (prepared, not executed)

Requires a restored isolated database. With one available, and pointing a **temporary** environment at it — never production credentials, ideally a read-only staging user:

```bash
node scripts/migrate.mjs status     # expect 25 applied, 0 pending, no checksum drift
npm run typecheck
npm run lint
npm test
npm run build
```

Then exercise read-only routes and confirm `/api/public/tier-list` returns the prior published snapshot, that no write job starts automatically, and that internal cron routes still return `401` without a bearer.

**Not executed:** no isolated database exists.

## 8. Phase 2 gate status

Updated 2026-07-19 after the isolated restore of a production-derived backup.

| Gate | Status | Notes |
|---|---|---|
| Backup artifact exists outside Hostinger | **MET (owner)** | Owner downloaded a ~1.1 GB Hostinger dump to a location outside this repository. The artifact itself is never committed. |
| Artifact checksum recorded | **OWNER RECORD** | Recorded by the owner alongside the artifact (`verify-backup.mjs` + `sha256sum`); not stored in-repo. |
| Artifact verified | **PASS** | The restore consumed the full dump without a load error (`--force` is never used, so a bad statement would have aborted). |
| Encrypted offsite copy | **OWNER ACTION** | Encryption/second-provider copy remains an operator responsibility (runbook §4). Not a code deliverable. |
| Isolated restore executed | **PASS** | `brawlranks_restoretest_20260719` on disposable MariaDB 11.8. |
| Restore invariants validated | **PASS** | `validate-restored-db.sql` — no FAIL verdict. |
| Application smoke test on restored DB | **PASS** | `scripts/dataset/smoke-restored-db.ts` — read-only, 105-item current snapshot served through the real repository. |
| Archived raw-object restore/replay | **MOSTLY MET → Phase 4** | Integrity replay + existing-validator dry-run proven; full battle-graph normalizer dry-run is the one deferred sub-item. |
| MySQL 8.4 compatibility proven | **IN PROGRESS → Phase 3** | Blocker (`battle_teams.rank`) resolved and clean migrations proven on a real MySQL 8.4 container — see `docs/dataset/phase3-mysql84-compat.md`. |
| Tooling and runbook exist | **MET** | — |

**Phase 2 core restore proof: MET.** The hard restorability gate DATASET.md
places before later phases is satisfied for the primary database. The single
remaining Phase 2 item — archived raw-object replay (B5) — is deferred to
Phase 4, which builds the archive object and replay path it would exercise.
Encryption and offsite-copy discipline (runbook §4) remain ongoing operator
responsibilities and are not code deliverables.
