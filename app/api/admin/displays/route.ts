import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson, requireString } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** Registers a display. Kiosks can no longer register themselves. */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<Record<string, unknown>>(req);

  const displayId = requireString(body.display_id, 'Display ID', 40).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(displayId)) {
    throw new HttpError(400, 'Display ID may only contain letters, numbers, dot, dash and underscore.');
  }
  const displayName = requireString(body.display_name, 'Display name', 80);
  const location = typeof body.location === 'string' && body.location.trim() ? body.location.trim().slice(0, 80) : 'Venue';
  const batch = typeof body.batch === 'string' && body.batch.trim() ? body.batch.trim().slice(0, 60) : 'ALL';

  const { data, error } = await getServiceClient()
    .from('event_displays')
    .insert({ display_id: displayId, display_name: displayName, location, batch, enabled: true })
    .select('*')
    .maybeSingle();

  if (error) {
    if (error.code === '23505') throw new HttpError(409, displayId + ' is already registered.');
    throw error;
  }

  await audit(account.account_id, 'DISPLAY_REGISTERED', displayId, displayName + ' (' + location + ')');
  return json({ display: data });
});
