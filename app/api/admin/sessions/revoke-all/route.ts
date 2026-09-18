import { NextRequest } from 'next/server';
import { audit, getSessionEpoch, invalidateSessionEpoch, requireSession, setSessionCookie } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/**
 * Ends every signed-in session — admins, operators, participants — by bumping
 * the global session epoch. Takes effect on each person's next request.
 *
 * The admin who pressed it is re-issued a cookie and stays signed in; being
 * locked out by your own emergency button helps nobody.
 *
 * Kiosk displays are not affected: they use device tokens, not sessions.
 */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const db = getServiceClient();

  const current = await getSessionEpoch();
  const next = current + 1;
  const { error } = await db
    .from('auth_settings')
    .update({ session_epoch: next, updated_at: new Date().toISOString() })
    .eq('id', true);
  if (error) throw error;

  invalidateSessionEpoch();
  await audit(account.account_id, 'ALL_SESSIONS_ENDED', 'ALL ACCOUNTS', 'Session epoch ' + current + ' → ' + next);

  const res = json({ ok: true });
  await setSessionCookie(res, account, next);
  return res;
});
