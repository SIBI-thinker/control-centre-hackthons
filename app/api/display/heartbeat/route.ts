import { NextRequest } from 'next/server';
import { getServiceClient } from '@/lib/server/db';
import { DISPLAY_COOKIE, sha256 } from '@/lib/server/display';
import { handle, HttpError, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/**
 * Kiosk heartbeat. Authenticated by the device token cookie, and returns the
 * display's current registry row — so a screen learns its identity, batch,
 * and enabled state from the server rather than from anything stored in the
 * browser that could be edited.
 *
 * 401 means the pairing is gone (display deleted or re-paired elsewhere) and
 * the kiosk should return to the pairing screen.
 */
export const POST = handle(async (req: NextRequest) => {
  const token = req.cookies.get(DISPLAY_COOKIE)?.value;
  if (!token) throw new HttpError(401, 'This screen is not paired.');

  const db = getServiceClient();
  const { data: credential, error } = await db
    .from('display_credentials')
    .select('display_uuid')
    .eq('device_token_hash', sha256(token))
    .maybeSingle();
  if (error) throw error;
  if (!credential) throw new HttpError(401, 'This screen is no longer paired.');

  const { data: display, error: updateError } = await db
    .from('event_displays')
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq('id', credential.display_uuid)
    .select('*')
    .maybeSingle();
  if (updateError) throw updateError;
  if (!display) throw new HttpError(401, 'This screen is no longer paired.');

  return json({ display });
});
