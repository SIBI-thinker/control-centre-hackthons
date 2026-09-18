import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json } from '@/lib/server/http';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/** Stops a clip (displays cut playback on their next check) or ends a live session. */
export const POST = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'broadcast id');
  const db = getServiceClient();

  const { data, error } = await db
    .from('audio_broadcasts')
    .update({ status: 'cancelled', ended_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'active')
    .select('title, kind, target')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'That broadcast is not playing.');

  if (data.kind === 'live') {
    await db.from('live_audio_peers').update({ state: 'closed', updated_at: new Date().toISOString() }).eq('broadcast_id', id);
  }

  await audit(account.account_id, data.kind === 'live' ? 'AUDIO_LIVE_ENDED' : 'AUDIO_CLIP_STOPPED', data.target, data.title);
  return json({ ok: true });
});
