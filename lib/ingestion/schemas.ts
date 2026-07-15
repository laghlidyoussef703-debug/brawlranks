/**
 * Defensive validators for the Phase 3 official-API endpoints (player,
 * club, rankings, battle log). Same design philosophy as
 * lib/catalog/schema.ts (Phase 2): require only the fields every
 * corroborating source agrees exist, treat everything else as optional,
 * never reject a record for carrying an unrecognized extra field.
 *
 * Verified this session against three independent third-party mirrors of
 * the official API (a JS wrapper's endpoint docs, a Python wrapper's
 * method signatures, and a typed Rust client's struct definitions) — not
 * against a live authenticated call (no local proxy credentials this
 * session). See PHASE3.md "Endpoint verification" for the full source
 * list and per-endpoint confidence level.
 */

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ---------------------------------------------------------------------------
// Player profile — GET /v1/players/{tag}
// ---------------------------------------------------------------------------

export interface ValidatedPlayer {
  tag: string;
  name: string;
  nameColor: string | null;
  trophies: number | null;
  highestTrophies: number | null;
  expLevel: number | null;
  clubTag: string | null;
}

export function validatePlayerPayload(raw: unknown): ValidatedPlayer | null {
  const record = obj(raw);
  if (!record) return null;

  const tag = str(record.tag);
  const name = str(record.name);
  if (!tag || !name) return null;

  const club = obj(record.club);

  return {
    tag,
    name,
    nameColor: str(record.nameColor),
    trophies: num(record.trophies),
    highestTrophies: num(record.highestTrophies),
    expLevel: num(record.expLevel),
    clubTag: club ? str(club.tag) : null,
  };
}

// ---------------------------------------------------------------------------
// Club profile (with embedded members) — GET /v1/clubs/{tag}
// ---------------------------------------------------------------------------

export interface ValidatedClubMember {
  tag: string;
  name: string;
  role: string | null;
  trophies: number | null;
  nameColor: string | null;
}

export interface ValidatedClub {
  tag: string;
  name: string;
  description: string | null;
  type: string | null;
  trophies: number | null;
  requiredTrophies: number | null;
  members: ValidatedClubMember[];
}

export function validateClubPayload(raw: unknown): ValidatedClub | null {
  const record = obj(raw);
  if (!record) return null;

  const tag = str(record.tag);
  const name = str(record.name);
  if (!tag || !name) return null;

  const membersRaw = Array.isArray(record.members) ? record.members : [];
  const members: ValidatedClubMember[] = [];
  for (const entry of membersRaw) {
    const memberRecord = obj(entry);
    if (!memberRecord) continue;
    const memberTag = str(memberRecord.tag);
    const memberName = str(memberRecord.name);
    if (!memberTag || !memberName) continue;
    members.push({
      tag: memberTag,
      name: memberName,
      role: str(memberRecord.role),
      trophies: num(memberRecord.trophies),
      nameColor: str(memberRecord.nameColor),
    });
  }

  return {
    tag,
    name,
    description: str(record.description),
    type: str(record.type),
    trophies: num(record.trophies),
    requiredTrophies: num(record.requiredTrophies),
    members,
  };
}

// ---------------------------------------------------------------------------
// Rankings — GET /v1/rankings/{countryCode}/{players|clubs|brawlers}
// ---------------------------------------------------------------------------

export interface ValidatedPlayerRankingEntry {
  tag: string;
  name: string;
  rank: number;
  trophies: number | null;
  clubName: string | null;
}

export interface ValidatedClubRankingEntry {
  tag: string;
  name: string;
  rank: number;
  trophies: number | null;
  memberCount: number | null;
}

export function validatePlayerRankingItems(items: unknown[]): {
  valid: ValidatedPlayerRankingEntry[];
  rejected: number;
} {
  const valid: ValidatedPlayerRankingEntry[] = [];
  let rejected = 0;
  for (const item of items) {
    const record = obj(item);
    const tag = record ? str(record.tag) : null;
    const name = record ? str(record.name) : null;
    const rank = record ? num(record.rank) : null;
    if (!record || !tag || !name || rank === null) {
      rejected += 1;
      continue;
    }
    const club = obj(record.club);
    valid.push({
      tag,
      name,
      rank,
      trophies: num(record.trophies),
      clubName: club ? str(club.name) : null,
    });
  }
  return { valid, rejected };
}

export function validateClubRankingItems(items: unknown[]): {
  valid: ValidatedClubRankingEntry[];
  rejected: number;
} {
  const valid: ValidatedClubRankingEntry[] = [];
  let rejected = 0;
  for (const item of items) {
    const record = obj(item);
    const tag = record ? str(record.tag) : null;
    const name = record ? str(record.name) : null;
    const rank = record ? num(record.rank) : null;
    if (!record || !tag || !name || rank === null) {
      rejected += 1;
      continue;
    }
    valid.push({
      tag,
      name,
      rank,
      trophies: num(record.trophies),
      memberCount: num(record.memberCount),
    });
  }
  return { valid, rejected };
}

// ---------------------------------------------------------------------------
// Battle log — GET /v1/players/{tag}/battlelog
// ---------------------------------------------------------------------------

export interface ValidatedBattleParticipant {
  tag: string;
  name: string;
  brawlerSourceId: string;
  brawlerName: string;
  brawlerPower: number | null;
  brawlerTrophies: number | null;
}

export interface ValidatedBattleItem {
  battleTime: string;
  eventSourceId: string | null;
  mode: string;
  map: string | null;
  battleType: string | null;
  duration: number | null;
  trophyChange: number | null;
  structure: "teams" | "solo_ranked";
  teams: ValidatedBattleParticipant[][];
  starPlayerTag: string | null;
  results: Array<{ result: "victory" | "defeat" | "draw" | "unknown"; rank: number | null }>;
}

function parseParticipant(raw: unknown): ValidatedBattleParticipant | null {
  const record = obj(raw);
  if (!record) return null;
  const tag = str(record.tag);
  const name = str(record.name);
  const brawler = obj(record.brawler);
  if (!tag || !name || !brawler) return null;

  const brawlerId = record.brawler !== undefined ? brawler.id : undefined;
  const brawlerSourceId =
    typeof brawlerId === "string" ? brawlerId.trim() : typeof brawlerId === "number" ? String(brawlerId) : "";
  const brawlerName = str(brawler.name);
  if (!brawlerSourceId || !brawlerName) return null;

  return {
    tag,
    name,
    brawlerSourceId,
    brawlerName,
    brawlerPower: num(brawler.power),
    brawlerTrophies: num(brawler.trophies),
  };
}

/**
 * Validates one battle-log entry. Returns null (quarantine candidate) if a
 * required structural field is missing: battleTime, event.mode, and at
 * least one resolvable participant across teams/players. A single
 * unresolved participant within an otherwise-valid battle does not reject
 * the whole battle — it is simply omitted from the returned participant
 * list (Section 7.4's "incomplete participant data" handling).
 */
export function validateBattleItem(raw: unknown): ValidatedBattleItem | null {
  const record = obj(raw);
  if (!record) return null;

  const battleTime = str(record.battleTime);
  const event = obj(record.event);
  const mode = event ? str(event.mode) : null;
  if (!battleTime || !mode) return null;

  const battle = obj(record.battle) ?? {};
  const battleTypeVal = str(battle.type);
  const durationVal = num(battle.duration);
  const trophyChangeVal = num(battle.trophyChange);
  const starPlayer = obj(battle.starPlayer);

  let teams: ValidatedBattleParticipant[][] = [];
  let structure: "teams" | "solo_ranked" = "solo_ranked";

  if (Array.isArray(battle.teams)) {
    structure = "teams";
    teams = battle.teams
      .filter((team): team is unknown[] => Array.isArray(team))
      .map((team) => team.map(parseParticipant).filter((p): p is ValidatedBattleParticipant => p !== null))
      .filter((team) => team.length > 0);
  } else if (Array.isArray(battle.players)) {
    structure = "solo_ranked";
    const parsed = battle.players
      .map(parseParticipant)
      .filter((p): p is ValidatedBattleParticipant => p !== null);
    teams = parsed.map((p) => [p]);
  }

  if (teams.length === 0) return null;

  const resultRaw = str(battle.result);
  const rankRaw = num(battle.rank);
  const results = teams.map((_, index) => {
    if (structure === "solo_ranked") {
      return { result: "unknown" as const, rank: index === 0 ? rankRaw : null };
    }
    const normalizedResult =
      resultRaw === "victory" || resultRaw === "defeat" || resultRaw === "draw"
        ? (resultRaw as "victory" | "defeat" | "draw")
        : ("unknown" as const);
    return { result: normalizedResult, rank: null };
  });

  return {
    battleTime,
    eventSourceId: event && num(event.id) !== null ? String(num(event.id)) : null,
    mode,
    map: event ? str(event.map) : null,
    battleType: battleTypeVal,
    duration: durationVal,
    trophyChange: trophyChangeVal,
    structure,
    teams,
    starPlayerTag: starPlayer ? str(starPlayer.tag) : null,
    results,
  };
}

export function validateBattleLogItems(items: unknown[]): {
  valid: ValidatedBattleItem[];
  rejected: number;
} {
  const valid: ValidatedBattleItem[] = [];
  let rejected = 0;
  for (const item of items) {
    const parsed = validateBattleItem(item);
    if (parsed) valid.push(parsed);
    else rejected += 1;
  }
  return { valid, rejected };
}
