#!/usr/bin/env bash
#
# DATASET Phase 2 — isolated restore driver.
#
# Restores a downloaded logical backup into a DISPOSABLE, clearly
# non-production database so the DATASET.md Phase 2 restore proof can be
# executed. It refuses, by design, to touch anything that looks like
# production.
#
# SAFETY MODEL (fail closed at every step):
#   1. The target database name must match ^brawlranks_restoretest_ .
#   2. Any name containing a known production marker is refused outright.
#   3. The target host must be a loopback address unless
#      ALLOW_REMOTE_TARGET=1 is explicitly exported by the operator.
#   4. If the target database already exists and is non-empty, the script
#      aborts rather than overwriting it.
#   5. The operator must confirm the target by typing it back, unless
#      --assume-yes is passed.
#   6. The backup file is opened read-only and is never modified.
#   7. No production credential is read. The script deliberately ignores
#      DB_HOST / DB_NAME / DB_USER / BRAWL_DB_SECRET_V1 so a stray
#      production environment cannot become the target.
#
# This script performs a RESTORE ONLY. It does not validate. Run
# scripts/dataset/validate-restored-db.sql afterwards; a restore is not
# proof until that passes.
#
# Usage:
#   ./scripts/dataset/restore-isolated.sh \
#       --backup /path/to/dump.sql.gz \
#       --database brawlranks_restoretest_20260718 \
#       [--host 127.0.0.1] [--port 3306] [--user root] [--assume-yes]
#
#   Password: set RESTORE_TARGET_PASSWORD, or use a protected option file
#   via MYSQL_OPTION_FILE. Never pass a password as an argument.
#
# Cleanup:
#   ./scripts/dataset/restore-isolated.sh --cleanup --database <name>

set -euo pipefail

REQUIRED_PREFIX="brawlranks_restoretest_"

# Names that must never be a restore target. Substring match, case-insensitive.
PRODUCTION_MARKERS=(
  "u350003894_brawl2"
  "u350003894"
  "brawl2"
  "prod"
  "production"
  "live"
  "main"
)

BACKUP=""
DATABASE=""
HOST="127.0.0.1"
PORT="3306"
USER="root"
ASSUME_YES=0
CLEANUP=0

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "  $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup)     BACKUP="${2:-}"; shift 2 ;;
    --database)   DATABASE="${2:-}"; shift 2 ;;
    --host)       HOST="${2:-}"; shift 2 ;;
    --port)       PORT="${2:-}"; shift 2 ;;
    --user)       USER="${2:-}"; shift 2 ;;
    --assume-yes) ASSUME_YES=1; shift ;;
    --cleanup)    CLEANUP=1; shift ;;
    -h|--help)    sed -n '2,40p' "$0"; exit 0 ;;
    *)            die "Unknown argument: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# Guard 1 + 2: target database identity. Fail closed on anything ambiguous.
# ---------------------------------------------------------------------------
[[ -n "$DATABASE" ]] || die "--database is required. The target must be named explicitly; there is no default."

lower_db="$(printf '%s' "$DATABASE" | tr '[:upper:]' '[:lower:]')"

if [[ "$lower_db" != "$REQUIRED_PREFIX"* ]]; then
  die "Refusing to proceed: target database '$DATABASE' does not start with '$REQUIRED_PREFIX'.
     This prefix is mandatory so an isolated restore target can never be mistaken for a real database."
fi

for marker in "${PRODUCTION_MARKERS[@]}"; do
  # Strip the mandatory prefix before scanning, so the prefix itself cannot
  # trip a marker and so a suffix like '..._brawl2' is still caught.
  suffix="${lower_db#"$REQUIRED_PREFIX"}"
  if [[ "$suffix" == *"$marker"* ]]; then
    die "Refusing to proceed: target database '$DATABASE' contains the production marker '$marker'.
     This is a hard stop. Choose a target name with no production identifier in it."
  fi
done

# ---------------------------------------------------------------------------
# Guard 3: target host must be local unless explicitly overridden.
# ---------------------------------------------------------------------------
case "$HOST" in
  127.0.0.1|localhost|::1|host.docker.internal) ;;
  *)
    if [[ "${ALLOW_REMOTE_TARGET:-0}" != "1" ]]; then
      die "Refusing to proceed: target host '$HOST' is not loopback.
     A remote target risks pointing at production. If you genuinely intend a remote
     disposable server, re-run with ALLOW_REMOTE_TARGET=1 exported."
    fi
    echo "WARNING: remote target '$HOST' permitted via ALLOW_REMOTE_TARGET=1." >&2
    ;;
esac

# ---------------------------------------------------------------------------
# Client resolution. Prefer the MariaDB client to match the source engine.
# ---------------------------------------------------------------------------
if command -v mariadb >/dev/null 2>&1; then
  CLIENT="mariadb"
elif command -v mysql >/dev/null 2>&1; then
  CLIENT="mysql"
else
  die "No 'mariadb' or 'mysql' client found on PATH.
     Install one, or run this inside a disposable container, e.g.:
       docker run --rm -d --name brawlranks-restoretest \\
         -e MARIADB_ROOT_PASSWORD=<local-only-password> -p 3307:3306 mariadb:10.11
     then re-run with --host 127.0.0.1 --port 3307."
fi

# Credentials are read from an option file or the environment — never argv,
# so they cannot leak into the process list.
CLIENT_ARGS=(--host="$HOST" --port="$PORT" --user="$USER" --protocol=TCP)
if [[ -n "${MYSQL_OPTION_FILE:-}" ]]; then
  CLIENT_ARGS=(--defaults-file="$MYSQL_OPTION_FILE" "${CLIENT_ARGS[@]}")
elif [[ -n "${RESTORE_TARGET_PASSWORD:-}" ]]; then
  export MYSQL_PWD="$RESTORE_TARGET_PASSWORD"
fi

run_sql() { "$CLIENT" "${CLIENT_ARGS[@]}" --batch --skip-column-names -e "$1"; }

# ---------------------------------------------------------------------------
# Cleanup mode.
# ---------------------------------------------------------------------------
if [[ "$CLEANUP" -eq 1 ]]; then
  echo "Cleanup: dropping disposable database '$DATABASE' on $HOST:$PORT"
  if [[ "$ASSUME_YES" -ne 1 ]]; then
    read -r -p "Type the database name to confirm the DROP: " confirm
    [[ "$confirm" == "$DATABASE" ]] || die "Confirmation did not match. Nothing was dropped."
  fi
  run_sql "DROP DATABASE IF EXISTS \`$DATABASE\`;"
  echo "Dropped '$DATABASE'. Disposable environment cleaned up."
  exit 0
fi

# ---------------------------------------------------------------------------
# Restore mode.
# ---------------------------------------------------------------------------
[[ -n "$BACKUP" ]] || die "--backup is required."
[[ -f "$BACKUP" ]] || die "Backup file not found: $BACKUP"
[[ -r "$BACKUP" ]] || die "Backup file is not readable: $BACKUP"

echo "Isolated restore plan"
info "backup file : $BACKUP"
info "size        : $(wc -c < "$BACKUP") bytes"
info "target host : $HOST:$PORT"
info "target db   : $DATABASE"
info "client      : $CLIENT"
echo ""
echo "This script will NOT modify the backup file and will NOT touch production."
echo ""

# Guard 5: explicit typed confirmation.
if [[ "$ASSUME_YES" -ne 1 ]]; then
  read -r -p "Type the target database name to confirm: " confirm
  [[ "$confirm" == "$DATABASE" ]] || die "Confirmation did not match '$DATABASE'. Nothing was changed."
fi

# Connectivity check before anything else.
run_sql "SELECT 1;" >/dev/null || die "Cannot connect to $HOST:$PORT as '$USER'."

# Guard 4: never overwrite a non-empty existing database.
existing_tables="$(run_sql "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DATABASE';" || echo 0)"
if [[ "${existing_tables:-0}" -gt 0 ]]; then
  die "Refusing to proceed: database '$DATABASE' already exists and contains $existing_tables table(s).
     This script never overwrites an existing populated database. Drop it first with --cleanup,
     or choose a new target name."
fi

echo "Creating empty target database..."
run_sql "CREATE DATABASE IF NOT EXISTS \`$DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

echo "Restoring (this may take a long time for a multi-GB dump)..."
started_at="$(date -u +%s)"

# The dump is streamed read-only. Nothing writes back to it.
# --force is deliberately NOT used: a failing statement must stop the restore
# so a partial restore is never mistaken for a successful one.
if [[ "$BACKUP" == *.gz ]]; then
  gzip -dc -- "$BACKUP" | "$CLIENT" "${CLIENT_ARGS[@]}" "$DATABASE"
else
  "$CLIENT" "${CLIENT_ARGS[@]}" "$DATABASE" < "$BACKUP"
fi

finished_at="$(date -u +%s)"
duration=$(( finished_at - started_at ))

table_count="$(run_sql "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DATABASE';")"

echo ""
echo "Restore completed."
info "duration    : ${duration}s"
info "tables      : $table_count"
info "database    : $DATABASE (disposable)"
echo ""
echo "NEXT — the restore is NOT proof yet. Run the validation suite:"
echo "  $CLIENT ${CLIENT_ARGS[*]} $DATABASE < scripts/dataset/validate-restored-db.sql"
echo ""
echo "Then record the real results in the backup manifest and clean up:"
echo "  $0 --cleanup --database $DATABASE"
