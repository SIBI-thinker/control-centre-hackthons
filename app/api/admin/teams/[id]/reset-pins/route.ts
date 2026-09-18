import { NextRequest } from 'next/server';
import { audit, invalidateAccount, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json } from '@/lib/server/http';
import { issuePins } from '@/lib/server/people';
import { parseUuid } from '@/lib/server/validate';
import type { IssuedCredential } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/**
 * New PINs for every member of a team — for when a credential sheet is lost.
 * PINs are only ever stored hashed, so reissuing is the only way to "reprint".
 * Every member is signed out.
 */
export const POST = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'team id');
  const db = getServiceClient();

  const { data: team, error: teamError } = await db.from('teams').select('id, code, name, room_id').eq('id', id).maybeSingle();
  if (teamError) throw teamError;
  if (!team) throw new HttpError(404, 'Team not found.');

  const { data: members, error } = await db
    .from('accounts')
    .select('id, account_id, display_name, session_version')
    .eq('team_id', id)
    .order('account_id');
  if (error) throw error;
  if (!members || members.length === 0) throw new HttpError(400, 'This team has no participants.');

  let roomLabel: string | null = null;
  if (team.room_id) {
    const { data: room } = await db.from('rooms').select('code, name').eq('id', team.room_id).maybeSingle();
    if (room) roomLabel = room.code + ' · ' + room.name;
  }

  const pins = await issuePins(members.length);
  const credentials: IssuedCredential[] = [];

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const { error: updateError } = await db
      .from('accounts')
      .update({ pin_hash: pins[i].hash, session_version: m.session_version + 1, updated_at: new Date().toISOString() })
      .eq('id', m.id);
    if (updateError) throw updateError;
    credentials.push({ account_id: m.account_id, display_name: m.display_name, role: 'participant', pin: pins[i].pin, team_name: team.name, room_label: roomLabel });
  }

  members.forEach((m) => invalidateAccount(m.id));
  await audit(account.account_id, 'TEAM_PINS_RESET', team.code, members.length + ' participants signed out');
  return json({ credentials });
});
