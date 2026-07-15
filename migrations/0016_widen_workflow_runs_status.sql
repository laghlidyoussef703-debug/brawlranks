-- Phase 3 hotfix: workflow_runs.status was VARCHAR(20), but its own CHECK
-- constraint (migration 0002) already allowed 'succeeded_with_warnings',
-- which is 23 characters — longer than the column could ever store.
-- Confirmed against a real MariaDB transaction: status='running' and
-- status='succeeded' succeed, status='succeeded_with_warnings' fails with
-- "ERROR 4025 (23000): CONSTRAINT chk_workflow_runs_status failed" (MariaDB
-- reports a too-long value as a CHECK failure, not a data-truncation
-- error, because the CHECK is evaluated against the value as supplied,
-- before/independent of column-width truncation behavior).
--
-- Forward-only fix: 0001-0015 are not modified. Widens the column to
-- VARCHAR(32) — enough headroom for every current status value plus
-- reasonable future ones — and recreates the CHECK constraint unchanged
-- (same six values migration 0002 already declared; this migration fixes
-- the column width, not the vocabulary).

ALTER TABLE workflow_runs
  DROP CONSTRAINT chk_workflow_runs_status;

ALTER TABLE workflow_runs
  MODIFY COLUMN status VARCHAR(32) NOT NULL DEFAULT 'running';

ALTER TABLE workflow_runs
  ADD CONSTRAINT chk_workflow_runs_status CHECK (
    status IN ('running', 'succeeded', 'succeeded_with_warnings', 'held', 'failed', 'rolled_back')
  );
