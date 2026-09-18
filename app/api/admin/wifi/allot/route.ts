import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/**
 * Hands unassigned logins out, one per team (or one per participant), to
 * whoever doesn't have one yet. Existing assignments are never disturbed, so
 * running it again only fills the gaps.
 */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<{ mode: string }>(req);
  const mode = body.mode === 'participants' ? 'participants' : body.mode === 'teams' ? 'teams' : null;
  if (!mode) throw new HttpError(400, 'Choose whether to allot per team or per participant.');

  const db = getServiceClient();
  const { data: pool, error } = await db
    .from('wifi_credentials')
    .select('id, username')
    .is('assigned_team_id', null)
    .is('assigned_account_id', null)
    .order('username');
  if (error) throw error;

  const available = pool ?? [];
  if (available.length === 0) throw new HttpError(409, 'No unassigned logins left in the pool. Import more first.');

  let waiting: { id: string; label: string }[] = [];

  if (mode === 'teams') {
    const [teams, assigned] = await Promise.all([
      db.from('teams').select('id, code, name').order('code'),
      db.from('wifi_credentials').select('assigned_team_id').not('assigned_team_id', 'is', null),
    ]);
    if (teams.error) throw teams.error;
    if (assigned.error) throw assigned.error;
    const have = new Set((assigned.data ?? []).map((a) => a.assigned_team_id));
    waiting = (teams.data ?? []).filter((t) => !have.has(t.id)).map((t) => ({ id: t.id, label: t.code + ' ' + t.name }));
  } else {
    const [people, assigned] = await Promise.all([
      db.from('accounts').select('id, account_id').eq('role', 'participant').eq('active', true).order('account_id'),
      db.from('wifi_credentials').select('assigned_account_id').not('assigned_account_id', 'is', null),
    ]);
    if (people.error) throw people.error;
    if (assigned.error) throw assigned.error;
    const have = new Set((assigned.data ?? []).map((a) => a.assigned_account_id));
    waiting = (people.data ?? []).filter((p) => !have.has(p.id)).map((p) => ({ id: p.id, label: p.account_id }));
  }

  if (waiting.length === 0) {
    throw new HttpError(409, mode === 'teams' ? 'Every team already has a login.' : 'Every participant already has a login.');
  }

  const pairs = waiting.slice(0, available.length).map((target, index) => ({ credentialId: available[index].id, target }));
  const column = mode === 'teams' ? 'assigned_team_id' : 'assigned_account_id';

  for (const pair of pairs) {
    const { error: updateError } = await db
      .from('wifi_credentials')
      .update({ [column]: pair.target.id, updated_at: new Date().toISOString() })
      .eq('id', pair.credentialId);
    if (updateError) throw updateError;
  }

  const shortfall = Math.max(0, waiting.length - available.length);
  await audit(account.account_id, 'WIFI_LOGINS_ALLOTTED', mode, pairs.length + ' allotted, ' + shortfall + ' still waiting');

  return json({ allotted: pairs.length, shortfall, mode });
});
