import { NextRequest } from 'next/server';
import { getServiceClient } from '@/lib/server/db';
import { clientIp, handle, HttpError, json, readJson } from '@/lib/server/http';
import { assertNotRateLimited, audit, getSessionEpoch, recordAttempt, setSessionCookie, type Account } from '@/lib/server/auth';
import { getDecoyHash, verifyPin } from '@/lib/server/pin';
import { ROLE_HOME, ROLE_SESSION_SECONDS } from '@/lib/session';

export const dynamic = 'force-dynamic';

// One message for every failure, so it never confirms whether an ID exists.
const INVALID = 'Invalid ID or PIN.';

export const POST = handle(async (req: NextRequest) => {
  const body = await readJson<{ accountId: string; pin: string }>(req);
  const accountId = typeof body.accountId === 'string' ? body.accountId.trim().toUpperCase() : '';
  const pin = typeof body.pin === 'string' ? body.pin.trim() : '';

  if (!accountId || !pin || accountId.length > 40 || pin.length > 12) {
    throw new HttpError(400, INVALID);
  }

  const ip = clientIp(req);
  await assertNotRateLimited(accountId, ip);

  const { data, error } = await getServiceClient()
    .from('accounts')
    .select('id, account_id, role, display_name, active, session_version, pin_hash')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;

  // Always run the KDF, even for unknown IDs, so timing reveals nothing.
  const pinMatches = await verifyPin(pin, data?.pin_hash ?? (await getDecoyHash()));

  if (!data || !data.active || !pinMatches) {
    await recordAttempt(accountId, ip, false);
    throw new HttpError(401, INVALID);
  }

  await recordAttempt(accountId, ip, true);

  const account: Account = {
    id: data.id,
    account_id: data.account_id,
    role: data.role,
    display_name: data.display_name,
    active: data.active,
    session_version: data.session_version,
  };

  const res = json({
    role: account.role,
    redirect: ROLE_HOME[account.role],
    expiresInSeconds: ROLE_SESSION_SECONDS[account.role],
  });
  await setSessionCookie(res, account, await getSessionEpoch());

  await getServiceClient().from('accounts').update({ last_login_at: new Date().toISOString() }).eq('id', account.id);
  await audit(account.account_id, 'SIGNED_IN', account.role.toUpperCase(), null);

  return res;
});
