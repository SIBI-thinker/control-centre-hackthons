import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson, requireString } from '@/lib/server/http';
import { loadWifiSettings } from '@/lib/server/wifi';
import { isUniqueViolation, optionalText, parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

/** Settings, the whole login pool, and who still has none. */
export const GET = handle(async (req: NextRequest) => {
  await requireSession(req, ['admin']);
  const db = getServiceClient();

  const [settings, credentials, teams, participants] = await Promise.all([
    loadWifiSettings(),
    db.from('wifi_credentials').select('*').order('username'),
    db.from('teams').select('id, name, code'),
    db.from('accounts').select('id, account_id, display_name, team_id').eq('role', 'participant'),
  ]);
  if (credentials.error) throw credentials.error;
  if (teams.error) throw teams.error;
  if (participants.error) throw participants.error;

  const teamName: Record<string, string> = {};
  (teams.data ?? []).forEach((t) => (teamName[t.id] = t.name));
  const personLabel: Record<string, string> = {};
  (participants.data ?? []).forEach((p) => (personLabel[p.id] = p.account_id + ' · ' + p.display_name));

  const rows = (credentials.data ?? []).map((c) => ({
    ...c,
    assigned_to: c.assigned_team_id
      ? { kind: 'team' as const, id: c.assigned_team_id, label: teamName[c.assigned_team_id] || 'deleted team' }
      : c.assigned_account_id
      ? { kind: 'participant' as const, id: c.assigned_account_id, label: personLabel[c.assigned_account_id] || 'deleted participant' }
      : null,
  }));

  const assignedTeams = new Set(rows.filter((r) => r.assigned_team_id).map((r) => r.assigned_team_id as string));
  const assignedPeople = new Set(rows.filter((r) => r.assigned_account_id).map((r) => r.assigned_account_id as string));

  return json({
    settings,
    credentials: rows,
    teams: (teams.data ?? []).map((t) => ({ ...t, has_wifi: assignedTeams.has(t.id) })),
    participants: (participants.data ?? []).map((p) => ({ ...p, has_wifi: assignedPeople.has(p.id) })),
    stats: {
      total: rows.length,
      unassigned: rows.filter((r) => !r.assigned_team_id && !r.assigned_account_id).length,
      teams_without: (teams.data ?? []).filter((t) => !assignedTeams.has(t.id)).length,
      participants_without: (participants.data ?? []).filter((p) => !assignedPeople.has(p.id)).length,
    },
  });
});

/** Adds one login by hand. */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<Record<string, unknown>>(req);

  const row = {
    username: requireString(body.username, 'Username', 120),
    password: requireString(body.password, 'Password', 120),
    label: optionalText(body.label, 120),
    assigned_team_id: body.assigned_team_id ? parseUuid(body.assigned_team_id, 'team') : null,
    assigned_account_id: body.assigned_account_id ? parseUuid(body.assigned_account_id, 'participant') : null,
  };
  if (row.assigned_team_id && row.assigned_account_id) throw new HttpError(400, 'Assign a login to a team or to one participant, not both.');

  const { data, error } = await getServiceClient().from('wifi_credentials').insert(row).select('id').single();
  if (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'That username, team or participant already has a login.');
    throw error;
  }

  await audit(account.account_id, 'WIFI_LOGIN_ADDED', row.username, row.label || null);
  return json({ id: data.id });
});
