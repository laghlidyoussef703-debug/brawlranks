/**
 * Parameterized SQL access for every Phase 3 table. Same conventions as
 * lib/catalog/repository.ts (Phase 2): every statement uses `?`
 * placeholders, every function takes an explicit connection so callers
 * control transaction boundaries, nothing opens its own connection.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

type Queryable = Pool | PoolConnection;

// ---------------------------------------------------------------------------
// canonical_game_modes / canonical_maps
// ---------------------------------------------------------------------------

export async function getOrCreateGameMode(
  db: Queryable,
  sourceModeId: string,
  name: string
): Promise<string> {
  const [existing] = await db.query<RowDataPacket[]>(
    "SELECT id FROM canonical_game_modes WHERE source_mode_id = ?",
    [sourceModeId]
  );
  if (existing.length > 0) {
    await db.execute(
      "UPDATE canonical_game_modes SET last_seen_at = NOW(3), is_active = 1, deactivated_at = NULL WHERE id = ?",
      [existing[0].id]
    );
    return existing[0].id;
  }

  const id = randomUUID();
  await db.execute(
    `INSERT INTO canonical_game_modes (id, source_mode_id, name, is_active, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 1, NOW(3), NOW(3))`,
    [id, sourceModeId, name]
  );
  return id;
}

export async function getOrCreateMap(
  db: Queryable,
  sourceMapId: string,
  name: string,
  gameModeId: string | null
): Promise<string> {
  const [existing] = await db.query<RowDataPacket[]>(
    "SELECT id FROM canonical_maps WHERE source_map_id = ?",
    [sourceMapId]
  );
  if (existing.length > 0) {
    await db.execute(
      "UPDATE canonical_maps SET last_seen_at = NOW(3), is_active = 1, deactivated_at = NULL WHERE id = ?",
      [existing[0].id]
    );
    return existing[0].id;
  }

  const id = randomUUID();
  await db.execute(
    `INSERT INTO canonical_maps (id, source_map_id, name, game_mode_id, is_active, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, 1, NOW(3), NOW(3))`,
    [id, sourceMapId, name, gameModeId]
  );
  return id;
}

// ---------------------------------------------------------------------------
// normalized_players / normalized_clubs / player_name_history
// ---------------------------------------------------------------------------

export interface PlayerRow {
  id: string;
  displayName: string;
}

export async function getPlayerByTag(db: Queryable, tag: string): Promise<PlayerRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, display_name FROM normalized_players WHERE player_tag = ?",
    [tag]
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, displayName: rows[0].display_name };
}

export async function upsertNormalizedPlayer(
  db: Queryable,
  params: {
    tag: string;
    displayName: string;
    nameColor: string | null;
    trophies: number | null;
    highestTrophies: number | null;
    expLevel: number | null;
    clubId: string | null;
    fetchRunId: string;
  }
): Promise<string> {
  const existing = await getPlayerByTag(db, params.tag);

  if (!existing) {
    const id = randomUUID();
    await db.execute(
      `INSERT INTO normalized_players
         (id, player_tag, display_name, name_color, trophies, highest_trophies, exp_level, club_id,
          is_reachable, first_seen_at, last_seen_at, last_fetch_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(3), NOW(3), ?)`,
      [
        id,
        params.tag,
        params.displayName,
        params.nameColor,
        params.trophies,
        params.highestTrophies,
        params.expLevel,
        params.clubId,
        params.fetchRunId,
      ]
    );
    return id;
  }

  if (existing.displayName !== params.displayName) {
    const historyId = randomUUID();
    await db.execute(
      `INSERT INTO player_name_history (id, player_id, previous_name) VALUES (?, ?, ?)`,
      [historyId, existing.id, existing.displayName]
    );
  }

  await db.execute(
    `UPDATE normalized_players
        SET display_name = ?, name_color = ?, trophies = ?, highest_trophies = ?, exp_level = ?,
            club_id = ?, is_reachable = 1, unreachable_reason = NULL, last_seen_at = NOW(3),
            last_fetch_run_id = ?
      WHERE id = ?`,
    [
      params.displayName,
      params.nameColor,
      params.trophies,
      params.highestTrophies,
      params.expLevel,
      params.clubId,
      params.fetchRunId,
      existing.id,
    ]
  );
  return existing.id;
}

/**
 * Ensures a minimal normalized_players row exists for a battle participant
 * whose full profile hasn't been fetched yet (fetching every opponent's
 * full profile would waste rate-limit budget the profile-crawl workflow
 * already owns — Section 7.23's "avoid wasted requests"). Only writes
 * display_name on first creation; never overwrites an existing row's
 * richer fields with this thin battle-observed name alone.
 */
export async function ensurePlayerStub(db: Queryable, tag: string, name: string, fetchRunId: string): Promise<string> {
  const existing = await getPlayerByTag(db, tag);
  if (existing) return existing.id;

  const id = randomUUID();
  await db.execute(
    `INSERT INTO normalized_players
       (id, player_tag, display_name, is_reachable, first_seen_at, last_seen_at, last_fetch_run_id)
     VALUES (?, ?, ?, 1, NOW(3), NOW(3), ?)
     ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at)`,
    [id, tag, name, fetchRunId]
  );

  const resolved = await getPlayerByTag(db, tag);
  return resolved!.id;
}

/**
 * Marks a player unreachable ONLY after retry policy is exhausted for a
 * confirmed 404 (Section 7 task rules — a transient failure must never
 * flip this flag). Callers are responsible for that gating; this function
 * performs the write unconditionally once called.
 */
export async function markPlayerUnreachable(db: Queryable, tag: string, reason: string): Promise<void> {
  await db.execute(
    "UPDATE normalized_players SET is_reachable = 0, unreachable_reason = ? WHERE player_tag = ?",
    [reason, tag]
  );
}

export interface ClubRow {
  id: string;
}

export async function getClubByTag(db: Queryable, tag: string): Promise<ClubRow | null> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT id FROM normalized_clubs WHERE club_tag = ?", [tag]);
  return rows.length > 0 ? { id: rows[0].id } : null;
}

export async function upsertNormalizedClub(
  db: Queryable,
  params: {
    tag: string;
    name: string;
    description: string | null;
    clubType: string | null;
    trophies: number | null;
    requiredTrophies: number | null;
    memberCount: number | null;
    fetchRunId: string;
  }
): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO normalized_clubs
       (id, club_tag, name, description, club_type, trophies, required_trophies, member_count, last_synced_at, last_fetch_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(3), ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name), description = VALUES(description), club_type = VALUES(club_type),
       trophies = VALUES(trophies), required_trophies = VALUES(required_trophies),
       member_count = VALUES(member_count), last_synced_at = VALUES(last_synced_at),
       last_fetch_run_id = VALUES(last_fetch_run_id)`,
    [
      id,
      params.tag,
      params.name,
      params.description,
      params.clubType,
      params.trophies,
      params.requiredTrophies,
      params.memberCount,
      params.fetchRunId,
    ]
  );

  const resolved = await getClubByTag(db, params.tag);
  return resolved!.id;
}

// ---------------------------------------------------------------------------
// seed_players / observed_players
// ---------------------------------------------------------------------------

export async function upsertSeedPlayer(
  db: Queryable,
  params: {
    tag: string;
    seedSource: string;
    region: string | null;
    trophyBracket: string | null;
    rank: number | null;
    trophies: number | null;
  }
): Promise<void> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO seed_players
       (id, player_tag, seed_source, region, trophy_bracket, latest_rank, latest_trophies, last_observed_at, is_stale)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3), 0)
     ON DUPLICATE KEY UPDATE
       latest_rank = VALUES(latest_rank), latest_trophies = VALUES(latest_trophies),
       last_observed_at = VALUES(last_observed_at), is_stale = 0`,
    [id, params.tag, params.seedSource, params.region, params.trophyBracket, params.rank, params.trophies]
  );
}

export async function recordObservedPlayer(
  db: Queryable,
  tag: string,
  sourceType: string,
  sourceDetail: unknown
): Promise<void> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO observed_players (id, player_tag, source_type, source_detail)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE source_type = source_type`,
    [id, tag, sourceType, sourceDetail !== undefined ? JSON.stringify(sourceDetail) : null]
  );
}

export async function getUnpromotedObservedPlayers(
  db: Queryable,
  limit: number
): Promise<Array<{ tag: string; sourceType: string }>> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT player_tag, source_type FROM observed_players
      WHERE promoted_to_active = 0
      ORDER BY first_observed_at ASC
      LIMIT ?`,
    [limit]
  );
  return rows.map((row) => ({ tag: row.player_tag, sourceType: row.source_type }));
}

export async function markObservedPlayerPromoted(db: Queryable, tag: string): Promise<void> {
  await db.execute(
    "UPDATE observed_players SET promoted_to_active = 1, promoted_at = NOW(3) WHERE player_tag = ?",
    [tag]
  );
}

// ---------------------------------------------------------------------------
// player_crawl_schedule
// ---------------------------------------------------------------------------

export async function ensureCrawlScheduleEntry(
  db: Queryable,
  params: { tag: string; region: string | null; trophyBracket: string | null; stratumSource: string; priorityScore: number }
): Promise<void> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO player_crawl_schedule
       (id, player_tag, priority_score, next_due_at, region, trophy_bracket, stratum_source, is_active)
     VALUES (?, ?, ?, NOW(3), ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       region = COALESCE(VALUES(region), region),
       trophy_bracket = COALESCE(VALUES(trophy_bracket), trophy_bracket)`,
    [id, params.tag, params.priorityScore, params.region, params.trophyBracket, params.stratumSource]
  );
}

/**
 * Clears any lease whose expires_at has passed (stuck-run recovery), then
 * selects up to `batchSize` due, unleased, non-backed-off active rows with
 * `FOR UPDATE SKIP LOCKED`, and immediately leases them to `runId`. Must be
 * called on a connection that is inside an open transaction — the caller
 * commits to persist the lease and release the row locks.
 */
export async function selectAndLeaseDuePlayers(
  connection: PoolConnection,
  runId: string,
  batchSize: number,
  leaseSeconds: number
): Promise<string[]> {
  await connection.execute(
    `UPDATE player_crawl_schedule
        SET leased_by_run_id = NULL, lease_expires_at = NULL
      WHERE lease_expires_at IS NOT NULL AND lease_expires_at < NOW(3)`
  );

  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT id, player_tag FROM player_crawl_schedule
      WHERE is_active = 1 AND next_due_at <= NOW(3)
        AND (backoff_until IS NULL OR backoff_until <= NOW(3))
        AND leased_by_run_id IS NULL
      ORDER BY priority_score DESC, next_due_at ASC
      LIMIT ?
      FOR UPDATE SKIP LOCKED`,
    [batchSize]
  );

  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id as string);
  const placeholders = ids.map(() => "?").join(", ");
  await connection.execute(
    `UPDATE player_crawl_schedule
        SET leased_by_run_id = ?, lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND)
      WHERE id IN (${placeholders})`,
    [runId, leaseSeconds, ...ids]
  );

  return rows.map((row) => row.player_tag as string);
}

export type CrawlOutcome = "success" | "failure_retryable" | "failure_dead";

export async function recordCrawlOutcome(
  db: Queryable,
  playerTag: string,
  outcome: CrawlOutcome,
  nextAttemptDelayMs: number
): Promise<void> {
  if (outcome === "success") {
    await db.execute(
      `UPDATE player_crawl_schedule
          SET last_crawled_at = NOW(3), next_due_at = DATE_ADD(NOW(3), INTERVAL ? MICROSECOND),
              consecutive_failure_count = 0, backoff_until = NULL,
              leased_by_run_id = NULL, lease_expires_at = NULL
        WHERE player_tag = ?`,
      [nextAttemptDelayMs * 1000, playerTag]
    );
  } else if (outcome === "failure_retryable") {
    await db.execute(
      `UPDATE player_crawl_schedule
          SET consecutive_failure_count = consecutive_failure_count + 1,
              backoff_until = DATE_ADD(NOW(3), INTERVAL ? MICROSECOND),
              leased_by_run_id = NULL, lease_expires_at = NULL
        WHERE player_tag = ?`,
      [nextAttemptDelayMs * 1000, playerTag]
    );
  } else {
    await db.execute(
      `UPDATE player_crawl_schedule
          SET is_active = 0, leased_by_run_id = NULL, lease_expires_at = NULL
        WHERE player_tag = ?`,
      [playerTag]
    );
  }
}

export async function getConsecutiveFailureCount(db: Queryable, playerTag: string): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT consecutive_failure_count FROM player_crawl_schedule WHERE player_tag = ?",
    [playerTag]
  );
  return rows.length > 0 ? rows[0].consecutive_failure_count : 0;
}

// ---------------------------------------------------------------------------
// normalized_battles / battle_teams / battle_participants / battle_observations
// ---------------------------------------------------------------------------

export async function getBattleIdByKey(db: Queryable, battleKey: string): Promise<string | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id FROM normalized_battles WHERE battle_key = ?",
    [battleKey]
  );
  return rows.length > 0 ? rows[0].id : null;
}

export interface InsertBattleParams {
  battleKey: string;
  gameModeId: string | null;
  mapId: string | null;
  eventSourceId: string | null;
  battleType: string | null;
  structure: "teams" | "solo_ranked";
  occurredAt: Date;
  durationSeconds: number | null;
  trophyChange: number | null;
  fetchRunId: string;
}

/**
 * Inserts a new normalized_battles row plus its teams. Callers must have
 * already confirmed (via getBattleIdByKey, in the same transaction) that no
 * row exists for this battle_key — the UNIQUE constraint is the final
 * safety net for a concurrent-insert race, not the primary check.
 */
export async function insertNormalizedBattle(
  db: Queryable,
  battle: InsertBattleParams,
  teams: Array<{ teamIndex: number; result: "victory" | "defeat" | "draw" | "unknown"; rank: number | null }>
): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO normalized_battles
       (id, battle_key, game_mode_id, map_id, event_source_id, battle_type, structure,
        occurred_at, duration_seconds, trophy_change, first_observed_fetch_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      battle.battleKey,
      battle.gameModeId,
      battle.mapId,
      battle.eventSourceId,
      battle.battleType,
      battle.structure,
      battle.occurredAt,
      battle.durationSeconds,
      battle.trophyChange,
      battle.fetchRunId,
    ]
  );

  for (const team of teams) {
    const teamId = randomUUID();
    await db.execute(
      `INSERT INTO battle_teams (id, battle_id, team_index, result, rank) VALUES (?, ?, ?, ?, ?)`,
      [teamId, id, team.teamIndex, team.result, team.rank]
    );
  }

  return id;
}

export async function getBattleTeamIds(db: Queryable, battleId: string): Promise<Map<number, string>> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, team_index FROM battle_teams WHERE battle_id = ?",
    [battleId]
  );
  return new Map(rows.map((row) => [row.team_index as number, row.id as string]));
}

export interface InsertParticipantParams {
  battleId: string;
  battleTeamId: string | null;
  playerId: string;
  brawlerId: string;
  brawlerPower: number | null;
  brawlerTrophies: number | null;
  participantIndex: number;
  isStarPlayer: boolean;
}

/**
 * Idempotent per (battle_id, player_id) via ON DUPLICATE KEY UPDATE — a
 * later, richer observation of the same participant updates power/trophies
 * only if the new value is present, never blanking a previously-known
 * value with a null from a thinner later observation.
 */
export async function upsertBattleParticipant(db: Queryable, params: InsertParticipantParams): Promise<void> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO battle_participants
       (id, battle_id, battle_team_id, player_id, brawler_id, brawler_power, brawler_trophies, participant_index, is_star_player)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       brawler_power = COALESCE(VALUES(brawler_power), brawler_power),
       brawler_trophies = COALESCE(VALUES(brawler_trophies), brawler_trophies),
       is_star_player = GREATEST(is_star_player, VALUES(is_star_player))`,
    [
      id,
      params.battleId,
      params.battleTeamId,
      params.playerId,
      params.brawlerId,
      params.brawlerPower,
      params.brawlerTrophies,
      params.participantIndex,
      params.isStarPlayer ? 1 : 0,
    ]
  );
}

/**
 * Idempotent per (battle_id, data_fetch_run_id) via ON DUPLICATE KEY UPDATE
 * no-op — recording the same fetch run's observation twice (e.g. a safe
 * replay) never creates a duplicate row.
 */
export async function insertBattleObservation(
  db: Queryable,
  battleId: string,
  fetchRunId: string,
  observedViaPlayerTag: string
): Promise<void> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO battle_observations (id, battle_id, data_fetch_run_id, observed_via_player_tag)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE battle_id = battle_id`,
    [id, battleId, fetchRunId, observedViaPlayerTag]
  );
}
