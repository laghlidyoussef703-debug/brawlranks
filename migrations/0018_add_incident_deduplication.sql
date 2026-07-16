-- Phase 4: Incident deduplication/aggregation.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.24 (Data-Quality Gates —
-- "never silently drop invalid records without traceability," which cuts
-- both ways: also never let one recurring root cause quietly multiply into
-- an unbounded number of near-identical open incidents).
--
-- Before this migration, every call to createIncident() always INSERTs a
-- new row — a single recurring validator gap (e.g. one battle-log shape
-- edge case hit on every crawl cycle) would otherwise create one incident
-- per affected fetch run forever. signature is an application-computed
-- SHA-256 hex (lib/ingestion/incidents.ts) of a stable subset of
-- (incident_type, data_category, related_entity_type, a normalized reason)
-- — deliberately NOT including related_fetch_run_id or timestamps, so
-- repeated occurrences of the same underlying problem collide on the same
-- signature. incident creation becomes an upsert: a new signature inserts
-- a row (occurrence_count = 1); a repeat increments occurrence_count and
-- bumps last_seen_at; a repeat of a previously '`resolved`' signature
-- reopens it (status reset to 'open') rather than silently accumulating a
-- second closed row for the same recurring issue.

ALTER TABLE data_incidents
  ADD COLUMN signature CHAR(64) NULL AFTER detail,
  ADD COLUMN occurrence_count INT NOT NULL DEFAULT 1 AFTER signature,
  ADD COLUMN last_seen_at DATETIME(3) NULL AFTER occurrence_count;

-- Backfill existing rows so the new columns are never left NULL for
-- already-open incidents from before this migration.
UPDATE data_incidents SET last_seen_at = created_at WHERE last_seen_at IS NULL;

ALTER TABLE data_incidents
  ADD UNIQUE KEY uniq_data_incidents_signature (incident_type, signature);

-- signature is nullable (a legacy/unsignatured incident, or one so
-- structurally unique that a stable signature doesn't apply, simply never
-- collides — MySQL/MariaDB UNIQUE indexes treat NULL as distinct from
-- every other NULL, so this never blocks a NULL-signature insert).
