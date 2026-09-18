import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/server/auth';
import { LIVE_STALE_MS } from '@/lib/server/audio';
import { getServiceClient } from '@/lib/server/db';
import { handle, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** Recent clips and live sessions, newest first. */
export const GET = handle(async (req: NextRequest) => {
  await requireSession(req, ['admin']);
  const { data, error } = await getServiceClient()
    .from('audio_broadcasts')
    .select('id, kind, title, target, duration_seconds, status, created_by, created_at, play_until, last_seen_at, ended_at')
    .order('created_at', { ascending: false })
    .limit(40);
  if (error) throw error;

  const now = Date.now();
  return json({
    serverNow: now,
    broadcasts: (data ?? []).map((b) => ({
      ...b,
      on_air:
        b.status === 'active' &&
        (b.kind === 'clip'
          ? Boolean(b.play_until) && new Date(b.play_until).getTime() > now
          : Boolean(b.last_seen_at) && now - new Date(b.last_seen_at).getTime() < LIVE_STALE_MS),
    })),
  });
});
