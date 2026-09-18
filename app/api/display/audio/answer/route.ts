import { NextRequest } from 'next/server';
import { LIVE_STALE_MS } from '@/lib/server/audio';
import { getServiceClient } from '@/lib/server/db';
import { requireDevice } from '@/lib/server/display';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

/** A kiosk's WebRTC answer to the offer the admin made for it. */
export const POST = handle(async (req: NextRequest) => {
  const display = await requireDevice(req);
  const body = await readJson<{ broadcast_id: string; sdp: string }>(req);
  const broadcastId = parseUuid(body.broadcast_id, 'broadcast id');
  if (typeof body.sdp !== 'string' || body.sdp.length > 20000 || body.sdp.indexOf('v=0') !== 0) {
    throw new HttpError(400, 'Invalid answer.');
  }

  const db = getServiceClient();
  const { data: broadcast, error } = await db
    .from('audio_broadcasts')
    .select('last_seen_at')
    .eq('id', broadcastId)
    .eq('kind', 'live')
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  if (!broadcast || !broadcast.last_seen_at || Date.now() - new Date(broadcast.last_seen_at).getTime() >= LIVE_STALE_MS) {
    throw new HttpError(410, 'This live session has ended.');
  }

  // Only answers an outstanding offer for THIS display.
  const { data, error: updateError } = await db
    .from('live_audio_peers')
    .update({ answer_sdp: body.sdp, state: 'answered', updated_at: new Date().toISOString() })
    .eq('broadcast_id', broadcastId)
    .eq('display_uuid', display.id)
    .eq('state', 'offered')
    .select('display_uuid')
    .maybeSingle();
  if (updateError) throw updateError;
  if (!data) throw new HttpError(409, 'No offer is waiting for this display.');

  return json({ ok: true });
});
