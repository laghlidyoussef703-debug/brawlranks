-- Phase 4: Preserve an unresolved club reference on a player profile.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.6 (canonical entity model —
-- join on canonical IDs, never a display value alone), Section 7.3 (club
-- as a seed/discovery source).
--
-- Root cause this fixes: normalized_players.club_id is a FK to
-- normalized_clubs, nullable, and playerProfileSync only ever performed a
-- READ lookup (getClubByTag) against it — if the club had never been
-- ingested (which, before this phase, it never automatically was), the
-- club reference was silently discarded entirely. There was no column
-- anywhere to remember "this player claims membership in club #TAG, we
-- haven't fetched that club yet" — confirmed by inspecting migration 0013,
-- which has no such field. This is why normalizedClubCount was 0 despite
-- 3,101 normalized players almost certainly including many with a club tag
-- in their raw profile payload.
--
-- pending_club_tag is intentionally NOT a foreign key (it may reference a
-- club that doesn't exist as a canonical row yet) and is cleared once
-- club_id is successfully resolved — see lib/ingestion/sync/clubSync.ts's
-- new backfill step and lib/ingestion/sync/playerProfileSync.ts's new
-- auto-trigger, both added in this phase.

ALTER TABLE normalized_players
  ADD COLUMN pending_club_tag VARCHAR(20) NULL AFTER club_id;

ALTER TABLE normalized_players
  ADD KEY idx_normalized_players_pending_club_tag (pending_club_tag);
