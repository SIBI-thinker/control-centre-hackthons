import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { iceServers, LIVE_STALE_MS, onlineTargetedDisplays } from '@/lib/server/audio';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson, requireString } from '@/lib/server/http';
import { parseTarget } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

/** Past this many screens the admin's upload is split too thin; see the fallback note in the UI. */
const MAX_LIVE_PEERS = 30;

/**
 * Starts a live mic session: one peer slot per enabled, online display the
 * target reaches. The admin's browser then creates a WebRTC offer for each.
 */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<{ title: string; target: string }>(req);
  const title = requireString(body.title, 'Title', 120);
  const target = parseTarget(body.target);
  const db = getServiceClient();

  // One live mic at a time: two admins talking over each other helps nobody.
  const { data: running, error: runningError } = await db
    .from('audio_broadcasts')
    .select('id, created_by, last_seen_at')
    .eq('kind', 'live')
    .eq('status', 'active');
  if (runningError) throw runningError;
  const now = Date.now();
  const stale = (running ?? []).filter((r) => !r.last_seen_at || now - new Date(r.last_seen_at).getTime() >= LIVE_STALE_MS);
  if (stale.length > 0) {
    await db.from('audio_broadcasts').update({ status: 'ended', ended_at: new Date().toISOString() }).in('id', stale.map((r) => r.id));
  }
  const live = (running ?? []).find((r) => stale.indexOf(r) === -1);
  if (live) throw new HttpError(409, 'A live mic is already on air (' + live.created_by + '). End it first.');

  const displays = await onlineTargetedDisplays(target);
  if (displays.length === 0) throw new HttpError(409, 'No online display is reached by that target.');
  if (displays.length > MAX_LIVE_PEERS) {
    throw new HttpError(409, 'That target reaches ' + displays.length + ' screens; live mic supports up to ' + MAX_LIVE_PEERS + '. Narrow the target or record a clip instead.');
  }

  const { data: broadcast, error } = await db
    .from('audio_broadcasts')
    .insert({ kind: 'live', title, target, created_by: account.account_id, last_seen_at: new Date().toISOString() })
    .select('id')
    .single();
  if (error) throw error;

  const { error: peersError } = await db
    .from('live_audio_peers')
    .insert(displays.map((d) => ({ broadcast_id: broadcast.id, display_uuid: d.id })));
  if (peersError) {
    await db.from('audio_broadcasts').delete().eq('id', broadcast.id);
    throw peersError;
  }

  await audit(account.account_id, 'AUDIO_LIVE_STARTED', target, title + ' → ' + displays.length + ' display(s)');

  return json({
    id: broadcast.id,
    iceServers: iceServers(),
    peers: displays.map((d) => ({ display_uuid: d.id, display_id: d.display_id, state: 'pending' })),
  });
});
