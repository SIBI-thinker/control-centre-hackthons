import { NextRequest } from 'next/server';
import { audit, invalidateAccount, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json } from '@/lib/server/http';
import { issuePins } from '@/lib/server/people';
import { parseUuid } from '@/lib/server/validate';
import type { IssuedCredential } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/** Issues a new PIN (shown once) and signs the person out everywhere. */
export const POST = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account: actor } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'account id');
  const db = getServiceClient();

  const { data: target, error } = await db
    .from('accounts')
    .select('id, account_id, role, display_name, session_version, team_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!target) throw new HttpError(404, 'Account not found.');
  if (target.id === actor.id) throw new HttpError(409, 'Change your own PIN from Settings — it needs your current PIN.');

  const [issued] = await issuePins(1);
  const { error: updateError } = await db
    .from('accounts')
    .update({ pin_hash: issued.hash, session_version: target.session_version + 1, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updateError) throw updateError;

  let teamName: string | null = null;
  if (target.team_id) {
    const { data: team } = await db.from('teams').select('name').eq('id', target.team_id).maybeSingle();
    teamName = team?.name ?? null;
  }

  invalidateAccount(target.id);
  await audit(actor.account_id, 'PIN_RESET', target.account_id, 'Signed out on all devices');

  const credential: IssuedCredential = {
    account_id: target.account_id,
    display_name: target.display_name,
    role: target.role,
    pin: issued.pin,
    team_name: teamName,
  };
  return json({ credential });
});
