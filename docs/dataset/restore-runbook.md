# BrawlRanks backup and restore runbook

Operator procedures for acquiring, verifying, storing, and restoring a BrawlRanks database backup.

> **This runbook never restores over production.** There is no procedure here for overwriting `u350003894_brawl2`, and `scripts/dataset/restore-isolated.sh` refuses that target by name. A production restore requires the separate authorization in section 9.

Terminal conventions: `$` = your workstation. Never paste a password on a command line — use a protected option file or an environment variable.

---

## 1. Create a Hostinger database backup

1. Hostinger panel → **Hosting** → your plan → **Files/Databases → Backups**.
2. Confirm **Database backups** (not Files backups — they are separate).
3. Automatic daily copies are retained; for a pre-migration or pre-change backup, use **Create backup** to make a custom one.
4. Verify the selected database is **`u350003894_brawl2`**.
5. Wait for **"Database backup prepared for download — Completed."**

**"Prepared" only means Hostinger built the artifact on its own infrastructure. It is not a backup you hold until you download it.**

## 2. Download the correct backup

1. In **Database backups**, locate the row for `u350003894_brawl2` at the intended timestamp.
2. Click **Download** — *not* Restore. Restore would write over the live database.
3. Save to a dedicated directory outside any Git repository:

   ```bash
   $ mkdir -p ~/brawlranks-backups
   # save the download there, e.g.
   # ~/brawlranks-backups/u350003894_brawl2-2026-07-18-0658.sql.gz
   ```

**Never save a backup inside `C:\Users\TOSHIBA\Desktop\brawl`.** `.gitignore` blocks the common patterns, but keeping it outside the repository entirely is the real protection.

## 3. Verify checksum and contents

```bash
$ cd /c/Users/TOSHIBA/Desktop/brawl
$ node scripts/dataset/verify-backup.mjs ~/brawlranks-backups/<file>
```

Records size, SHA-256, format, gzip integrity, expected tables, DEFINER clauses, charset, MariaDB-only syntax, and embedded-credential risk. Never connects to a database and never modifies the file.

Record the SHA-256 independently as well, so it can be re-checked after any transfer:

```bash
$ sha256sum ~/brawlranks-backups/<file> | tee ~/brawlranks-backups/<file>.sha256
```

Re-verify after every copy or move:

```bash
$ sha256sum -c ~/brawlranks-backups/<file>.sha256
```

Then create the manifest:

```bash
$ node scripts/dataset/create-backup-manifest.mjs ~/brawlranks-backups/<file> \
    --source-env production --operator "<your name>" \
    --out ~/brawlranks-backups/<file>.manifest.json
```

The manifest refuses to write if any field looks secret-bearing. `restoreTest.status` will read `NOT_PERFORMED` — **only edit it after section 6 actually passes.**

If no artifact is available yet, generate the fill-in template:

```bash
$ node scripts/dataset/create-backup-manifest.mjs --template
```

## 4. Store it outside Git, encrypted

Encrypt before it leaves the workstation or goes to any second location.

Using `age` (recommended — simple, modern, no key server):

```bash
$ age-keygen -o ~/.brawlranks-backup-key.txt     # once; back up this key separately
$ grep 'public key' ~/.brawlranks-backup-key.txt  # note the recipient
$ age -r <age1...recipient> \
    -o ~/brawlranks-backups/<file>.age ~/brawlranks-backups/<file>
$ sha256sum ~/brawlranks-backups/<file>.age >> ~/brawlranks-backups/<file>.sha256
```

Using GPG:

```bash
$ gpg --symmetric --cipher-algo AES256 ~/brawlranks-backups/<file>
```

Storage rules:

- Keep **one copy with a provider other than Hostinger**. A Hostinger account incident must not take the database and every backup at once.
- Retention: 7 daily, 5 weekly, 12 monthly, 7 annual. Pre-migration and pre-cutover backups ≥13 months.
- The encryption key is stored **separately** from the backups. A key stored beside the ciphertext provides no protection.
- Backup-upload credentials are write-only; restore credentials are separate.

## 5. Isolated restore

### 5.1 Start a disposable engine

Match the source engine (MariaDB) for the primary test.

```bash
# MariaDB — matches Hostinger
$ docker run --rm -d --name brawlranks-restoretest \
    -e MARIADB_ROOT_PASSWORD='<local-only-password>' \
    -p 3307:3306 mariadb:10.11

# MySQL 8.4 — for the compatibility matrix (expect the battle_teams.rank blocker)
$ docker run --rm -d --name brawlranks-mysql84test \
    -e MYSQL_ROOT_PASSWORD='<local-only-password>' \
    -p 3308:3306 mysql:8.4
```

Port 3307/3308, never 3306, so a local production-ish instance can never be hit by accident. The password is local-only and disposable — **never reuse a production credential**.

### 5.2 Restore

```bash
$ export RESTORE_TARGET_PASSWORD='<local-only-password>'
$ ./scripts/dataset/restore-isolated.sh \
    --backup ~/brawlranks-backups/<file> \
    --database brawlranks_restoretest_20260718 \
    --host 127.0.0.1 --port 3307 --user root
```

The script will refuse to continue if the target name lacks the `brawlranks_restoretest_` prefix, contains a production marker, is non-loopback without `ALLOW_REMOTE_TARGET=1`, or already holds tables. It asks you to type the target name back. Record the reported duration and table count.

If the dump contains DEFINER clauses (`verify-backup.mjs` reports this), strip them into a **copy** — never modify the original:

```bash
$ gzip -dc ~/brawlranks-backups/<file> \
  | sed -E 's/DEFINER=`[^`]*`@`[^`]*`//g' \
  | gzip > ~/brawlranks-backups/<file>.nodefiner.gz
```

## 6. Validate the restore

```bash
$ mysql --host=127.0.0.1 --port=3307 --user=root \
    brawlranks_restoretest_20260718 \
    < scripts/dataset/validate-restored-db.sql \
    | tee ~/brawlranks-backups/restore-validation-20260718.txt
```

Expected:

| Check | Expected |
|---|---|
| `00_target_identity` | PASS — if this FAILs, **stop immediately**, you are not on an isolated target |
| `02_migration_count` | 25, checksums matching `schema-inventory.mjs --json` |
| `03_table_count` | ≥46 (45 from migrations + `schema_migrations`) |
| `04_non_innodb` | 0 |
| `05_foreign_key_count` | ≥60 — a low number means FKs were lost in the restore |
| `05_generated_columns` | 5 |
| `05_battle_key_unique` | 1 — the dedup guarantee |
| `06_current_snapshot_count` | 0 or 1, never more |
| `07_current_rule_sets` | 1 |
| `11_battle_dedupe` | total = deduped |
| `12_orphan_*` | all 0 |
| `14_*_leak` | all 0 |

**Do not modify data to make a check pass.** A real failure is the finding.

Record the actual results in the manifest's `restoreTest` block. Only now may `status` change from `NOT_PERFORMED`.

## 7. Application smoke test (optional but recommended)

With the restored database running, in a **temporary** shell — never write these into `.env`:

```bash
$ export DB_HOST=127.0.0.1 DB_PORT=3307 \
         DB_NAME=brawlranks_restoretest_20260718 \
         DB_USER=root BRAWL_DB_SECRET_V1='<local-only-password>'
$ node scripts/migrate.mjs status    # 25 applied, 0 pending, no drift

# Read-only public-contract smoke test through the REAL repository code.
# Refuses any non-isolated / non-loopback / production target (fail closed).
$ npx tsx scripts/dataset/smoke-restored-db.ts
```

`smoke-restored-db.ts` exercises `lib/publishedSnapshots/repository.ts` via
`getPool()` and asserts the current published snapshot serves its items,
correctly shaped and ordered — issuing only SELECTs and starting no write job.
It is the read-only equivalent of confirming `/api/public/tier-list` serves the
prior published snapshot. Internal cron routes still return `401` without a
bearer (covered by the route-auth tests). A full `npm run typecheck && lint &&
test && build` may additionally be run, but those exercise the codebase, not
the restored data specifically.

Prefer a least-privilege staging user over root. Never export a production credential into a shell that also has an isolated target configured.

## 8. Evidence to retain

Per restore test, kept with the manifest: backup filename and SHA-256, source environment and engine version, isolated engine and version, restore start time and duration, restored database name, table count, critical row counts, migration status output, full validation output, smoke-test results, and cleanup confirmation.

## 9. Production restore safeguards

**A production restore is a last resort and is never routine.**

Decision criteria — a production restore is considered only when:

- production data is confirmed lost or corrupted beyond repair, **and**
- the loss is larger than what replay from `raw_api_snapshots` can reconstruct, **and**
- a verified backup exists whose restore test passed within the last 35 days, **and**
- the named rollback authority has approved it in writing.

Mandatory before any production restore:

1. **Take a fresh backup of the current production state first**, even if it is believed corrupt. Never overwrite the only surviving copy.
2. Verify the restore-source checksum against its manifest.
3. Confirm the restore-source passed section 6 on an isolated copy — restoring an unproven backup over production can turn a recoverable incident into an unrecoverable one.
4. Confirm all timers are disabled and no workflow is running.
5. Record final counts, current snapshot id, and workflow state from the pre-restore database.
6. Have the rollback path written down before starting.

**Approval:** the repository owner (Laghli Youssef) must approve in writing. This tooling cannot perform it and must not be extended to.

### Preventing accidental restore over production

- `scripts/dataset/restore-isolated.sh` refuses production names, non-prefixed names, non-loopback hosts, and populated targets, and never reads production environment variables. Enforced by `tests/datasetToolingSafety.test.ts`.
- `validate-restored-db.sql` section 0 refuses to certify a non-isolated target.
- In the Hostinger panel, **Download** and **Restore** sit next to each other. Restore overwrites the live database. Read the button before clicking.
- Never export production `DB_*` / `BRAWL_DB_SECRET_V1` in a shell used for restore testing.

## 10. Rollback

**Isolated restore test failed:**

```bash
$ ./scripts/dataset/restore-isolated.sh --cleanup --database brawlranks_restoretest_20260718
$ docker rm -f brawlranks-restoretest
```

Production is untouched — nothing to roll back. Record the failure; do not retry against a different target hoping for a different result.

**Production restore went wrong:** stop all writers, do not start timers, restore the pre-restore backup taken in section 9 step 1, re-run validation, and escalate to the rollback authority. Keep the failed state for forensics.

## 11. Cleanup

```bash
$ ./scripts/dataset/restore-isolated.sh --cleanup --database brawlranks_restoretest_20260718
$ docker rm -f brawlranks-restoretest brawlranks-mysql84test
$ unset RESTORE_TARGET_PASSWORD DB_HOST DB_PORT DB_NAME DB_USER BRAWL_DB_SECRET_V1
```

Keep the backup artifact and its manifest. Delete only the disposable database and container.

---

## Quick reference

| Task | Command |
|---|---|
| Verify a backup | `node scripts/dataset/verify-backup.mjs <file>` |
| Manifest a backup | `node scripts/dataset/create-backup-manifest.mjs <file> --out <file>.manifest.json` |
| Manifest template | `node scripts/dataset/create-backup-manifest.mjs --template` |
| Restore (isolated) | `./scripts/dataset/restore-isolated.sh --backup <file> --database brawlranks_restoretest_<date> --port 3307` |
| Validate a restore | `mysql --port=3307 -u root <db> < scripts/dataset/validate-restored-db.sql` |
| Clean up | `./scripts/dataset/restore-isolated.sh --cleanup --database <db>` |
| Schema inventory | `node scripts/dataset/schema-inventory.mjs --out schema-inventory.json` |
| Compatibility check | `node scripts/dataset/compatibility-check.mjs` |
