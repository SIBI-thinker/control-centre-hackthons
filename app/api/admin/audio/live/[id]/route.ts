import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/server/auth';
import { onlineTargetedDisplays } from '@/lib/server/audio';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json } from '@/lib/server/http';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/**
 * The admin's browser calls this every second while live. It:
 *   - records the admin is still there (displays drop a session that goes quiet)
 *   - adds slots for displays that came online after the session started
 *   - returns each display's answer once it has one
 */
export const GET = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'broadcast id');
  const db = getServiceClient();

  const { data: broadcast, error } = await db
    .from('audio_broadcasts')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', id)
    .eq('kind', 'live')
    .eq('status', 'active')
    .eq('created_by', account.account_id)
    .select('target')
    .maybeSingle();
  if (error) throw error;
  if (!broadcast) throw new HttpError(410, 'This live session has ended.');

  const { data: peers, error: peersError } = await db
    .from('live_audio_peers')
    .select('display_uuid, state, answer_sdp')
    .eq('broadcast_id', id);
  if (peersError) throw peersError;

  const known = new Set((peers ?? []).map((p) => p.display_uuid));
  const online = await onlineTargetedDisplays(broadcast.target);
  const late = online.filter((d) => !known.has(d.id));
  if (late.length > 0) {
    await db.from('live_audio_peers').upsert(
      late.map((d) => ({ broadcast_id: id, display_uuid: d.id })),
      { onConflict: 'broadcast_id,display_uuid', ignoreDuplicates: true }
    );
  }

  const labels: Record<string, string> = {};
  online.forEach((d) => (labels[d.id] = d.display_id));
  const missingLabels = (peers ?? []).map((p) => p.display_uuid).filter((uuid) => !labels[uuid]);
  if (missingLabels.length > 0) {
    const { data: rows } = await db.from('event_displays').select('id, display_id').in('id', missingLabels);
    (rows ?? []).forEach((r) => (labels[r.id] = r.display_id));
  }

  return json({
    peers: (peers ?? [])
      .map((p) => ({ ...p, display_id: labels[p.display_uuid] || 'display', online: online.some((d) => d.id === p.display_uuid) }))
      .concat(late.map((d) => ({ display_uuid: d.id, state: 'pending', answer_sdp: null, display_id: d.display_id, online: true }))),
  });
});
