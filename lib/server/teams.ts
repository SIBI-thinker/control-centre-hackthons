import 'server-only';

/**
 * Pointing a CSV row at one specific team.
 *
 * Team names are not unique — two rooms may each run a "Team 5" — so a name on
 * its own can be ambiguous. The team CODE is unique, so a file can always name
 * a team unambiguously by using it. Ambiguity is reported, never guessed:
 * silently picking one of two teams would put a participant in the wrong room.
 */

export type TeamRef = { id: string; code: string; name: string; room_id?: string | null };

export type TeamMatch =
  | { kind: 'team'; team: TeamRef }
  | { kind: 'ambiguous'; matches: TeamRef[] }
  | { kind: 'none' };

export function buildTeamIndex(teams: TeamRef[]) {
  const byCode = new Map<string, TeamRef>();
  const byId = new Map<string, TeamRef>();
  const byName = new Map<string, TeamRef[]>();

  const add = (team: TeamRef) => {
    byCode.set(team.code.toUpperCase(), team);
    byId.set(team.id, team);
    const key = team.name.trim().toLowerCase();
    const list = byName.get(key);
    if (list) list.push(team);
    else byName.set(key, [team]);
  };

  teams.forEach(add);

  /** A code wins over a name, so "T-004" always means that one team. */
  const match = (value: string): TeamMatch => {
    const raw = (value || '').trim();
    if (!raw) return { kind: 'none' };

    const byCodeHit = byCode.get(raw.toUpperCase());
    if (byCodeHit) return { kind: 'team', team: byCodeHit };

    const hits = byName.get(raw.toLowerCase());
    if (!hits || hits.length === 0) return { kind: 'none' };
    if (hits.length === 1) return { kind: 'team', team: hits[0] };
    return { kind: 'ambiguous', matches: hits };
  };

  /**
   * Strict lookup for a column that is meant to hold a code (or the raw row
   * id). Never falls back to names — the whole point of that column is to be
   * unambiguous.
   */
  const matchCode = (value: string): TeamRef | null => {
    const raw = (value || '').trim();
    if (!raw) return null;
    return byCode.get(raw.toUpperCase()) || byId.get(raw) || null;
  };

  /** Every team carrying this name, in any room. */
  const matchName = (value: string): TeamRef[] => {
    const raw = (value || '').trim();
    if (!raw) return [];
    return byName.get(raw.toLowerCase()) ?? [];
  };

  return { match, matchCode, matchName, add };
}

/** The message shown on an ambiguous row — it names the codes to choose from. */
export function ambiguousTeamMessage(value: string, matches: TeamRef[]): string {
  return (
    matches.length +
    ' teams are named "' +
    value.trim() +
    '" — put the team code in this column instead (' +
    matches.map((t) => t.code).join(', ') +
    ')'
  );
}

export type TeamIndex = ReturnType<typeof buildTeamIndex>;

export type ImportTeamOutcome =
  | { kind: 'error'; message: string }
  | { kind: 'existing'; team: TeamRef }
  | { kind: 'new'; name: string };

/**
 * Decides which team one CSV row belongs to.
 *
 * `teamCode` (the team_id column) is exact and wins; the name beside it is
 * then only checked for disagreement, because a row that says both "Byte Me"
 * and T-004 is a mistake somewhere and guessing which half to trust is how a
 * participant ends up in the wrong room.
 *
 * A NAME is only ever matched within the room the row names. Names repeat, so
 * "Hack Horizon" in F201 is simply not the "Hack Horizon" sitting in F101 —
 * it is a second team, and treating it as the first one would drop a whole
 * roster into the wrong room. The name is matched across all rooms only when
 * the row leaves the room column blank and there is nothing better to go on.
 *
 * `roomId` is the room the row asks for, already resolved — null when the
 * column is blank or names a room that doesn't exist (reported separately).
 */
export function resolveImportTeam(opts: {
  index: TeamIndex;
  teamName: string;
  teamCode: string;
  roomId: string | null;
}): ImportTeamOutcome {
  const teamName = (opts.teamName || '').trim();
  const teamCode = (opts.teamCode || '').trim();

  if (!teamName && !teamCode) return { kind: 'error', message: 'Team is required — give a team name or a team id' };

  if (teamCode) {
    const pinned = opts.index.matchCode(teamCode);
    if (!pinned) {
      return { kind: 'error', message: 'No team has the id ' + teamCode + ' — leave team_id blank to create a team from the name' };
    }
    if (opts.roomId && pinned.room_id !== opts.roomId) {
      return { kind: 'error', message: 'Team ' + pinned.code + ' is in a different room — remove the team id to start a new team here' };
    }
    if (teamName && teamName.toLowerCase() !== pinned.name.trim().toLowerCase()) {
      return { kind: 'error', message: 'Team id ' + pinned.code + ' is "' + pinned.name + '", not "' + teamName + '"' };
    }
    return { kind: 'existing', team: pinned };
  }

  // The team column may itself hold a code; that is exact, so honour it.
  const asCode = opts.index.matchCode(teamName);
  if (asCode) {
    if (opts.roomId && asCode.room_id !== opts.roomId) {
      return { kind: 'error', message: 'Team ' + asCode.code + ' is in a different room — use the team name to start a new team here' };
    }
    return { kind: 'existing', team: asCode };
  }

  const candidates = opts.index.matchName(teamName);

  if (opts.roomId) {
    const inRoom = candidates.filter((t) => t.room_id === opts.roomId);
    if (inRoom.length === 1) return { kind: 'existing', team: inRoom[0] };
    if (inRoom.length > 1) return { kind: 'error', message: ambiguousTeamMessage(teamName, inRoom) };
    // Same name, different room: a different team.
    return { kind: 'new', name: teamName };
  }

  if (candidates.length === 1) return { kind: 'existing', team: candidates[0] };
  if (candidates.length > 1) return { kind: 'error', message: ambiguousTeamMessage(teamName, candidates) };
  return { kind: 'new', name: teamName };
}

/**
 * Groups new teams within one file by name AND room — the same name in two
 * rooms means two teams. JSON keeps the two parts separate without inventing
 * a separator that a team name might itself contain.
 */
export function newTeamKey(name: string, roomCode: string): string {
  return JSON.stringify([name.trim().toLowerCase(), roomCode.trim().toUpperCase()]);
}

export type NewTeamGroup = { name: string; roomCode: string };

/**
 * Settles which new team each row belongs to, once the whole file is known.
 *
 * A row that names a new team but leaves the room blank joins the room its
 * team-mates gave, so one empty cell doesn't split a team into two records.
 * When those rows name more than one room there is nothing to infer, and the
 * row is reported rather than guessed at.
 */
export function reconcileNewTeamRooms(
  keys: (string | null)[],
  groups: Map<string, NewTeamGroup>
): { keys: (string | null)[]; errors: (string | null)[] } {
  const roomsForName = new Map<string, Set<string>>();
  groups.forEach((group) => {
    if (!group.roomCode) return;
    const nameKey = group.name.trim().toLowerCase();
    const rooms = roomsForName.get(nameKey) ?? new Set<string>();
    rooms.add(group.roomCode);
    roomsForName.set(nameKey, rooms);
  });

  const outKeys: (string | null)[] = [];
  const errors: (string | null)[] = [];

  keys.forEach((key) => {
    const group = key ? groups.get(key) : null;
    if (!key || !group || group.roomCode) {
      outKeys.push(key);
      errors.push(null);
      return;
    }
    const rooms = Array.from(roomsForName.get(group.name.trim().toLowerCase()) ?? []);
    if (rooms.length === 1) {
      outKeys.push(newTeamKey(group.name, rooms[0]));
      errors.push(null);
    } else if (rooms.length > 1) {
      outKeys.push(key);
      errors.push(
        'Rows for new team "' + group.name + '" name different rooms (' + rooms.join(', ') + ') — give the room on every row'
      );
    } else {
      outKeys.push(key);
      errors.push(null);
    }
  });

  return { keys: outKeys, errors };
}
