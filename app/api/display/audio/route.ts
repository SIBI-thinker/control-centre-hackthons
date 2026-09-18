import { NextRequest } from 'next/server';
import { AUDIO_BUCKET, CLIP_URL_TTL_SECONDS, iceServers, LIVE_STALE_MS } from '@/lib/server/audio';
import { getServiceClient } from '@/lib/server/db';
import { requireDevice } from '@/lib/server/display';
import { handle, json, readJson } from '@/lib/server/http';
import { isTargetedAt } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * A paired kiosk's audio check, every couple of seconds. Returns:
 *   clip  the newest clip still playable for this display, with a short-lived URL
 *   live  the live session reaching this display, and its pending offer if any
 *
 * Body { rejoin: <broadcast id> } asks for a fresh offer — used when a display
 * reloaded mid-session and lost its connection.
 */
export const POST = handle(async (req: NextRequest) => {
  const display = await requireDevice(req);
  const body = await readJson<{ rejoin?: string }>(req).catch(() => ({} as { rejoin?: string }));
  const db = getServiceClient();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  if (!display.enabled) return json({ clip: null, live: null });

  const { data: active, error } = await db
    .from('audio_broadcasts')
    .select('id, kind, title, target, storage_path, mime_type, duration_seconds, created_at, play_until, last_seen_at')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;

  const mine = (active ?? []).filter((b) => isTargetedAt(b.target, display));

  // ------------------------------------------------------------------ clip
  let clip = null;
  const clipRow = mine.find((b) => b.kind === 'clip' && b.play_until && new Date(b.play_until).getTime() > now);
  if (clipRow && clipRow.storage_path) {
    const { data: signed, error: signError } = await db.storage.from(AUDIO_BUCKET).createSignedUrl(clipRow.storage_path, CLIP_URL_TTL_SECONDS);
    if (!signError && signed) {
      clip = {
        id: clipRow.id,
        title: clipRow.title,
        url: signed.signedUrl,
        duration_seconds: Number(clipRow.duration_seconds),
        sent_at: clipRow.created_at,
      };
    }
  }

  // ------------------------------------------------------------------ live
  let live = null;
  const liveRow = mine.find((b) => b.kind === 'live' && b.last_seen_at && now - new Date(b.last_seen_at).getTime() < LIVE_STALE_MS);
  if (liveRow) {
    if (typeof body.rejoin === 'string' && body.rejoin === liveRow.id) {
      await db
        .from('live_audio_peers')
        .upsert(
          { broadcast_id: liveRow.id, display_uuid: display.id, state: 'pending', offer_sdp: null, answer_sdp: null, updated_at: nowIso },
          { onConflict: 'broadcast_id,display_uuid' }
        );
    }

    const { data: peer, error: peerError } = await db
      .from('live_audio_peers')
      .select('state, offer_sdp')
      .eq('broadcast_id', liveRow.id)
      .eq('display_uuid', display.id)
      .maybeSingle();
    if (peerError) throw peerError;

    live = {
      id: liveRow.id,
      title: liveRow.title,
      state: peer ? peer.state : 'pending',
      offer_sdp: peer && peer.state === 'offered' ? peer.offer_sdp : null,
      ice_servers: iceServers(),
    };
  }

  return json({ clip, live });
});
