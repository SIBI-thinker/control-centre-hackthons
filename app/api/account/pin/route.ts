import { NextRequest } from 'next/server';
import { assertNotRateLimited, audit, getSessionEpoch, invalidateAccount, recordAttempt, requireSession, setSessionCookie } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { clientIp, handle, HttpError, json, readJson } from '@/lib/server/http';
import { hashPin, validatePin, verifyPin } from '@/lib/server/pin';

export const dynamic = 'force-dynamic';

/**
 * Changes the signed-in person's own PIN.
 *
 * Requires the current PIN, so an unattended signed-in laptop can't be used to
 * take over the account. Bumps session_version, which ends every other session
 * of this account; the current browser gets a fresh cookie and stays signed in.
 */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin', 'operator', 'participant']);
  const body = await readJson<{ currentPin: string; newPin: string }>(req);

  const ip = clientIp(req);
  await assertNotRateLimited(account.account_id, ip);

  const newPinError = validatePin(body.newPin);
  if (newPinError) throw new HttpError(400, newPinError);

  const db = getServiceClient();
  const { data: row, error } = await db.from('accounts').select('pin_hash').eq('id', account.id).maybeSingle();
  if (error) throw error;
  if (!row) throw new HttpError(401, 'Your session has ended. Sign in again.');

  if (typeof body.currentPin !== 'string' || !(await verifyPin(body.currentPin, row.pin_hash))) {
    await recordAttempt(account.account_id, ip, false);
    throw new HttpError(401, 'Current PIN is incorrect.');
  }
  if (body.currentPin === body.newPin) throw new HttpError(400, 'New PIN must be different from the current one.');

  const nextVersion = account.session_version + 1;
  const { error: updateError } = await db
    .from('accounts')
    .update({ pin_hash: await hashPin(body.newPin as string), session_version: nextVersion, updated_at: new Date().toISOString() })
    .eq('id', account.id);
  if (updateError) throw updateError;

  invalidateAccount(account.id);
  await audit(account.account_id, 'PIN_CHANGED', account.account_id, 'Other sessions for this account were ended');

  const res = json({ ok: true });
  await setSessionCookie(res, { ...account, session_version: nextVersion }, await getSessionEpoch());
  return res;
});
