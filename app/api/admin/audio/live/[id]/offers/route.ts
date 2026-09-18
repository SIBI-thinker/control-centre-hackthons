import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/** Stores the admin's WebRTC offer for one or more displays of a live session. */
export const POST = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'broadcast id');
  const body = await readJson<{ offers: { display_uuid: string; sdp: string }[] }>(req);
  if (!Array.isArray(body.offers) || body.offers.length === 0 || body.offers.length > 30) {
    throw new HttpError(400, 'Provide between 1 and 30 offers.');
  }

  const db = getServiceClient();
  const { data: broadcast, error } = await db
    .from('audio_broadcasts')
    .select('id')
    .eq('id', id)
    .eq('kind', 'live')
    .eq('status', 'active')
    .eq('created_by', account.account_id)
    .maybeSingle();
  if (error) throw error;
  if (!broadcast) throw new HttpError(410, 'This live session has ended.');

  for (const offer of body.offers) {
    const displayUuid = parseUuid(offer.display_uuid, 'display');
    if (typeof offer.sdp !== 'string' || offer.sdp.length > 20000 || offer.sdp.indexOf('v=0') !== 0) {
      throw new HttpError(400, 'Invalid offer.');
    }
    // Only for a slot that exists in this session — the admin can't aim an
    // offer at a display the target doesn't reach.
    const { error: updateError } = await db
      .from('live_audio_peers')
      .update({ offer_sdp: offer.sdp, answer_sdp: null, state: 'offered', updated_at: new Date().toISOString() })
      .eq('broadcast_id', id)
      .eq('display_uuid', displayUuid);
    if (updateError) throw updateError;
  }

  return json({ ok: true });
});
