# Phase 8–9 incremental synchronization and database roles

Status: implementation and operator documentation only. This document does
not authorize production synchronization, environment changes, timer changes,
writer/read cutover, or Phase 10.

## Authoritative requirements versus implementation choices

DATASET.md requires scheduled incremental synchronization followed later by a
short controlled write pause; stable composite cursors; a fixed upper
watermark; overlap; durable state/manifests; immutable comparison; dependency
ordering; reconciliation; and separate read/write pools with legacy fallback.

Engineering choices in this implementation:

- State and manifests are external atomic JSON files (`MIGRATION_SYNC_STATE_DIR`),
  not an application-schema table. Files are created with restrictive modes,
  flushed, and atomically renamed.
- Tables without reliable timestamps use a deterministic SHA-256(primary-key)
  composite scan, not UUID-only ordering. Parent-driven tables additionally
  require the target parent and terminal parent status where applicable.
- Migrations 0026–0029 postdate the Phase 8 matrix. Their tables are included
  beside the raw or derived family that owns them.
- Source and target schema metadata is compared through `information_schema`;
  generated columns are verified but omitted from inserts.

## Environment matrix

| Purpose | Required names | Optional names |
|---|---|---|
| Legacy fallback | `DB_HOST`, `DB_NAME`, `DB_USER`, `BRAWL_DB_SECRET_V1` | `DB_PORT` |
| Write role | `WRITE_DB_HOST`, `WRITE_DB_NAME`, `WRITE_DB_USER`, `WRITE_DB_SECRET` | `WRITE_DB_PORT`, `WRITE_DB_POOL_SIZE`, `WRITE_DB_CA_PATH`/`WRITE_DB_CA`, `WRITE_DB_SSL`, `WRITE_DB_SSL_REJECT_UNAUTHORIZED` |
| Read role | `READ_DB_HOST`, `READ_DB_NAME`, `READ_DB_USER`, `READ_DB_SECRET` | `READ_DB_PORT`, `READ_DB_POOL_SIZE`, `READ_DB_CA_PATH`/`READ_DB_CA`, `READ_DB_SSL`, `READ_DB_SSL_REJECT_UNAUTHORIZED` |
| Sync source | `SOURCE_DB_HOST`, `SOURCE_DB_NAME`, `SOURCE_DB_USER`, `SOURCE_DB_SECRET`, verified TLS | `SOURCE_DB_PORT`, `SOURCE_DB_CA_PATH`/`SOURCE_DB_CA`, `SOURCE_DB_POOL_SIZE` |
| Sync target | `TARGET_DB_HOST`, `TARGET_DB_NAME`, `TARGET_DB_USER`, `TARGET_DB_SECRET`, verified TLS | `TARGET_DB_PORT`, `TARGET_DB_CA_PATH`/`TARGET_DB_CA`, `TARGET_DB_POOL_SIZE` |
| Sync state | `MIGRATION_SYNC_STATE_DIR` recommended | defaults to `.migration-sync-state` for local disposable work only |

Any role-specific variable activates validation for that role; partial role
configuration fails. If neither role is populated, both getters return the
same legacy pool and the first deployment behaves exactly as before.

## CLI

All examples assume credentials are injected by the operator’s secret manager.
Never put values on a command line or in shell history.

```bash
npm run migration:sync -- inspect-config
npm run migration:sync -- test-source
npm run migration:sync -- test-target
npm run migration:sync -- init-state
npm run migration:sync -- dry-run --family parent-runs --page-size 500
npm run migration:sync -- apply --family parent-runs --page-size 500
npm run migration:sync -- pass --apply --page-size 500
npm run migration:sync -- repeat --passes 3 --apply --page-size 500
npm run migration:sync -- reconcile
npm run migration:sync -- resume --apply --family parent-runs
npm run migration:sync -- state
npm run migration:sync -- manifests --limit 5
npm run migration:sync -- lag
npm run migration:sync -- readiness --passes 3 --apply
npm run migration:sync -- export-report --out phase8-validation-report.json
npm run migration:sync -- sample-report   # synthetic local evidence; no DB
```

`apply` is never implicit. Target-only deletion is refused except for
`workflow_locks`, and even there requires both apply mode and
`--allow-reconcile-delete`. No source write statement exists in the tool.

## Deployment order for the role abstraction

1. Run lint, typecheck, Phase 8–9 tests, full tests, and build.
2. Deploy code with no `READ_DB_*` or `WRITE_DB_*`; verify both safe role
   descriptions say `source: legacy` and the public contract is unchanged.
3. If explicit role variables are operationally desired before cutover, point
   both roles to Hostinger first. Verify both connection-only health checks.
4. Confirm workflow/ingestion routes use the write role and `/api/public/tier-list`
   uses the read role without logging credentials.
5. Do not change either endpoint to DigitalOcean in this phase. That is a
   separately approved Phase 10/later operation.

Safe local/config verification:

```bash
npm run test:phase8-9
npx tsx -e "import {describeDbRole} from './lib/mysql'; console.log(describeDbRole('read')); console.log(describeDbRole('write'))"
```

The descriptions include endpoint identity and TLS booleans, never passwords.
Connection-only application role checks are available through
`checkDbRoleConnection('read'|'write')` in `lib/mysql.ts`; invoke them only in
an approved deployment environment.

## Rollback

For the abstraction-only release, remove role variables (or restore the prior
deployment environment) and redeploy the prior application artifact. Both
roles then use `DB_*` and the legacy singleton. This rollback changes no schema,
data, timer, or cursor. Preserve Phase 8 state/manifests for investigation; do
not delete source or target rows.

If a synchronization pass fails, correct the cause and use `resume`. The fixed
watermark and durable lower cursor are retained. The failed page is retried;
the cursor was not advanced. A fatal immutable mismatch requires investigation,
not an ignore flag.

## Readiness and Phase boundary

Phase 8 production catch-up is validated only after three consecutive apply
passes each have global lag below 60 seconds and all reconciliation checks pass.
The CLI records that sequence in external readiness state. Final catch-up,
timer pause, writer canary, writer cutover, and reader cutover are Phase 10 or
later and are explicitly not implemented or authorized here.
