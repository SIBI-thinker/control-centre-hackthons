/**
 * Team names may repeat — two rooms can each run a "Team 5". Where a list
 * shows names on their own, the repeated ones need their code beside them, or
 * an admin picking from a dropdown has no way to tell them apart.
 */

export type NamedTeam = { code: string; name: string };

/** Lower-cased names held by more than one team. */
export function duplicateTeamNames(teams: { name: string }[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  teams.forEach((t) => {
    const key = t.name.trim().toLowerCase();
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  });
  return duplicates;
}

/** "Byte Me", or "Team 5 (T-004)" when the name alone is ambiguous. */
export function teamLabel(team: NamedTeam, duplicates: Set<string>): string {
  return duplicates.has(team.name.trim().toLowerCase()) ? team.name + ' (' + team.code + ')' : team.name;
}
