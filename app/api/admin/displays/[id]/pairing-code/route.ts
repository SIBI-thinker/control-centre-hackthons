import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { generatePairingCode, PAIRING_CODE_TTL_MINUTES, sha256 } from '@/lib/server/display';
import { handle, HttpError, json } from '@/lib/server/http';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/**
 * Issues a one-time pairing code for a display. Generating a new code revokes
 * the display's existing device token, so re-pairing a screen also kicks off
 * whatever kiosk held it before.
 */
export const POST = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'display id');
  const db = getServiceClient();

  const { data: display, error: lookupError } = await db
    .from('event_displays')
    .select('id, display_id')
    .eq('id', id)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (!display) throw new HttpError(404, 'Display not found.');

  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MINUTES * 60 * 1000).toISOString();

  const { error } = await db.from('display_credentials').upsert({
    display_uuid: display.id,
    pairing_code_hash: sha256(code),
    pairing_expires_at: expiresAt,
    device_token_hash: null,
    paired_at: null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;

  await audit(account.account_id, 'DISPLAY_PAIRING_CODE_ISSUED', display.display_id, 'Valid ' + PAIRING_CODE_TTL_MINUTES + ' minutes');

  // The plain code is returned exactly once; only its hash is stored.
  return json({ code, expiresAt, displayId: display.display_id });
});
