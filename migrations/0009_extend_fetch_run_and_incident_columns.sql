-- Phase 3: Forward-only extension of two Phase 2 tables to support the
-- centralized retry/backoff policy and richer incident classification this
-- phase needs. This migration does NOT modify 0003/0008 (already-applied
-- migration files are never edited — see scripts/migrate.mjs's checksum
-- drift protection); it ALTERs the resulting tables in a new, separately
-- checksummed file, which is the safe forward-migration path.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.21 (data_fetch_runs fields:
-- "attempt count, next attempt time, last safe error code, last safe error
-- message, final/dead status, retry reason"), Section 7.24 (data_incidents
-- classification), Section 29 (failure handling).

ALTER TABLE data_fetch_runs
  ADD COLUMN request_context LONGTEXT NULL AFTER trigger_type,
  ADD COLUMN next_attempt_at DATETIME(3) NULL AFTER completed_at,
  ADD COLUMN retry_reason VARCHAR(50) NULL AFTER error_message,
  ADD COLUMN retry_of_fetch_run_id CHAR(36) NULL AFTER workflow_run_id;

-- request_context holds fetch-specific parameters only (e.g. {"countryCode":
-- "US"}, {"playerTag":"#ABC123"}, {"clubTag":"#XYZ987"}) for run
-- traceability across every ingestion domain (rankings-per-region, one
-- player crawl, one club fetch) without a proliferation of near-duplicate
-- tables. It must never contain a secret, credential, or Authorization
-- header value — enforced in application code (lib/ingestion/*), never by
-- the schema alone.

ALTER TABLE data_fetch_runs
  ADD CONSTRAINT fk_data_fetch_runs_retry_of
    FOREIGN KEY (retry_of_fetch_run_id) REFERENCES data_fetch_runs (id);

ALTER TABLE data_fetch_runs
  DROP CONSTRAINT chk_data_fetch_runs_status,
  ADD CONSTRAINT chk_data_fetch_runs_status CHECK (
    status IN ('pending', 'running', 'success', 'partial', 'failed', 'timeout', 'dead')
  );

-- 'dead' marks a run whose failure was classified as permanently
-- non-retryable (Section 29) — e.g. a stale/invalid player tag (404) or a
-- schema mismatch — distinct from 'failed', which may still be retried by
-- a later scheduled attempt per the retry policy in lib/ingestion/retry.ts.

ALTER TABLE data_incidents
  ADD COLUMN data_category VARCHAR(30) NULL AFTER incident_type;

ALTER TABLE data_incidents
  DROP CONSTRAINT chk_data_incidents_type,
  ADD CONSTRAINT chk_data_incidents_type CHECK (
    incident_type IN (
      'schema_mismatch', 'invalid_value', 'unknown_entity',
      'volume_collapse', 'source_disagreement', 'partial_payload',
      'transaction_failure', 'checksum_inconsistency',
      'rate_limit_exhausted', 'stuck_lease'
    )
  );

-- data_category (api_response/battle/player/club/ranking) mirrors Section
-- 7.21's data_quality_results.data_category, letting one incident stream
-- (already established in Phase 2) serve every Phase 3 ingestion domain
-- rather than introducing a parallel incidents table.
