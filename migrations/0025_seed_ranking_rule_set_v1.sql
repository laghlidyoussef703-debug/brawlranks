-- Phase 5.3: seeds the exact MVP rule set from the Phase 5.3 owner-decision
-- report into the tables migration 0021 created empty. Values are copied
-- verbatim from that report — not re-derived or reinterpreted here.
--
-- Per-mode tier_thresholds rows are seeded via INSERT ... SELECT against
-- canonical_game_modes (active modes only) rather than hardcoded mode IDs,
-- since mode UUIDs are generated at catalog-sync time and are not known at
-- migration-authoring time. A MySQL session variable (@ruleset_id) carries
-- the newly-generated ranking_rule_sets id across the statements in this
-- file — supported here because scripts/migrate.mjs connects with
-- `multipleStatements: true`.

SET @ruleset_id = UUID();

INSERT INTO ranking_rule_sets (id, version, description, is_active, activated_at, created_by)
VALUES (
  @ruleset_id,
  1,
  'Phase 5.3 MVP rule set: win-rate-primary overall/mode scoring, percentile tiers (90/70/30/10), matchup bands at +/-15pp around 50%, patch-blend transition weight = min(1, current_patch_matches/100). See the Phase 5.3 owner-decision report for full justification.',
  1,
  NOW(3),
  'system'
);

INSERT INTO ranking_rule_weights (id, ranking_rule_set_id, signal_name, weight, min_sample_size, extra_config) VALUES
  (UUID(), @ruleset_id, 'win_rate',            0.500000, 100, '{"scope":"overall"}'),
  (UUID(), @ruleset_id, 'pick_rate',           0.200000, 100, '{"scope":"overall","player_cap":20}'),
  (UUID(), @ruleset_id, 'high_rank_win_rate',  0.200000,  30, '{"scope":"overall","fallback":"win_rate"}'),
  (UUID(), @ruleset_id, 'matchup_coverage',    0.100000,  20, '{"scope":"overall","fallback_value":0.5}'),
  (UUID(), @ruleset_id, 'mode_win_rate',       0.700000,  30, '{"scope":"mode"}'),
  (UUID(), @ruleset_id, 'mode_pick_rate',      0.300000,  30, '{"scope":"mode","player_cap":20}');

-- Overall scope (mode_scope = NULL).
INSERT INTO tier_thresholds (id, ranking_rule_set_id, mode_scope, threshold_type, s_cutoff, a_cutoff, b_cutoff, c_cutoff)
VALUES (UUID(), @ruleset_id, NULL, 'percentile', 90, 70, 30, 10);

-- One identical row per currently-active canonical game mode, generated
-- programmatically — never a hardcoded mode ID.
INSERT INTO tier_thresholds (id, ranking_rule_set_id, mode_scope, threshold_type, s_cutoff, a_cutoff, b_cutoff, c_cutoff)
SELECT UUID(), @ruleset_id, id, 'percentile', 90, 70, 30, 10
  FROM canonical_game_modes
 WHERE is_active = 1;
