import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson, requireString } from '@/lib/server/http';
import { nextSequentialIds } from '@/lib/server/people';
import { isUniqueViolation, parseCode, parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

export const GET = handle(async (req: NextRequest) => {
  await requireSession(req, ['admin']);
  const db = getServiceClient();
  const [teams, members] = await Promise.all([
    db.from('teams').select('*').order('code'),
    db.from('accounts').select('team_id').eq('role', 'participant'),
  ]);
  if (teams.error) throw teams.error;
  if (members.error) throw members.error;

  const counts: Record<string, number> = {};
  (members.data ?? []).forEach((m) => {
    if (m.team_id) counts[m.team_id] = (counts[m.team_id] ?? 0) + 1;
  });

  return json({ teams: (teams.data ?? []).map((t) => ({ ...t, member_count: counts[t.id] ?? 0 })) });
});

export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<Record<string, unknown>>(req);

  const name = requireString(body.name, 'Team name', 80);
  const roomId = body.room_id ? parseUuid(body.room_id, 'room id') : null;
  const code = body.code ? parseCode(body.code, 'Team code', false) : (await nextSequentialIds('teams', 'code', 'T-', 1, 3))[0];

  const { data, error } = await getServiceClient()
    .from('teams')
    .insert({ code, name, room_id: roomId })
    .select('*')
    .maybeSingle();
  if (error) {
    if (isUniqueViolation(error)) {
      const detail = ((error.message || '') + ' ' + (error.details || '')).toLowerCase();
      if (detail.indexOf('teams_name_key') !== -1) {
        throw new HttpError(409, 'The database still requires unique team names. Apply the 20260918140000_allow_duplicate_team_names migration to use a name twice.');
      }
      throw new HttpError(409, 'That team code is already in use. Names may repeat, codes may not.');
    }
    if (error.code === '23503') throw new HttpError(400, 'That room no longer exists.');
    throw error;
  }

  await audit(account.account_id, 'TEAM_CREATED', code, name);
  return json({ team: data });
});
