import { NextRequest } from 'next/server';
import { assertNotRateLimited, audit, recordAttempt } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { generateDeviceToken, normalizePairingCode, setDisplayCookie, sha256 } from '@/lib/server/display';
import { clientIp, handle, HttpError, json, readJson } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const RATE_KEY = 'DISPLAY_PAIRING';
const INVALID = 'That pairing code is invalid or has expired.';

/** Exchanges a one-time pairing code for this kiosk's device token. */
export const POST = handle(async (req: NextRequest) => {
  const ip = clientIp(req);
  await assertNotRateLimited(RATE_KEY, ip);

  const body = await readJson<{ code: string }>(req);
  const code = normalizePairingCode(body.code);
  if (!code) {
    await recordAttempt(RATE_KEY, ip, false);
    throw new HttpError(400, INVALID);
  }

  const db = getServiceClient();
  const { data: credential, error } = await db
    .from('display_credentials')
    .select('display_uuid, pairing_expires_at')
    .eq('pairing_code_hash', sha256(code))
    .maybeSingle();
  if (error) throw error;

  if (!credential || !credential.pairing_expires_at || new Date(credential.pairing_expires_at).getTime() < Date.now()) {
    await recordAttempt(RATE_KEY, ip, false);
    throw new HttpError(401, INVALID);
  }

  const token = generateDeviceToken();

  // Consuming the code in the same conditional update means two kiosks racing
  // with one code can't both pair: only the first still matches the hash.
  const { data: consumed, error: consumeError } = await db
    .from('display_credentials')
    .update({
      pairing_code_hash: null,
      pairing_expires_at: null,
      device_token_hash: sha256(token),
      paired_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('display_uuid', credential.display_uuid)
    .eq('pairing_code_hash', sha256(code))
    .select('display_uuid')
    .maybeSingle();
  if (consumeError) throw consumeError;
  if (!consumed) {
    await recordAttempt(RATE_KEY, ip, false);
    throw new HttpError(401, INVALID);
  }

  const { data: display, error: displayError } = await db
    .from('event_displays')
    .select('*')
    .eq('id', credential.display_uuid)
    .maybeSingle();
  if (displayError) throw displayError;
  if (!display) throw new HttpError(404, 'Display no longer exists.');

  await recordAttempt(RATE_KEY, ip, true);
  await audit('SYSTEM', 'DISPLAY_PAIRED', display.display_id, 'Kiosk paired from ' + ip);

  const res = json({ display });
  setDisplayCookie(res, token);
  return res;
});
