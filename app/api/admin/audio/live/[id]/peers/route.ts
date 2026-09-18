import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/** The admin's browser reports which display connections came up or failed. */
export const PATCH = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'broadcast id');
  const body = await readJson<{ updates: { display_uuid: string; state: string }[] }>(req);
  if (!Array.isArray(body.updates) || body.updates.length > 30) throw new HttpError(400, 'Invalid peer updates.');

  const db = getServiceClient();
  const { data: broadcast, error } = await db
    .from('audio_broadcasts')
    .select('id')
    .eq('id', id)
    .eq('created_by', account.account_id)
    .maybeSingle();
  if (error) throw error;
  if (!broadcast) throw new HttpError(404, 'Session not found.');

  for (const update of body.updates) {
    if (update.state !== 'connected' && update.state !== 'failed') continue;
    const { error: updateError } = await db
      .from('live_audio_peers')
      .update({ state: update.state, updated_at: new Date().toISOString() })
      .eq('broadcast_id', id)
      .eq('display_uuid', parseUuid(update.display_uuid, 'display'));
    if (updateError) throw updateError;
  }
  return json({ ok: true });
});
