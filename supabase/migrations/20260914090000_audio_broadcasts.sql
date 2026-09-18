/*
# Audio broadcasts — recorded clips and live mic

## Tables (server-only: RLS on, no policies, privileges revoked)
- audio_broadcasts   one row per clip or live session, with its target
- live_audio_peers   per-display WebRTC offer/answer for a live session

## Storage
- bucket "audio-broadcasts" (PRIVATE, 10 MB per file, audio types only).
  Displays never get a permanent link: the server hands each paired kiosk a
  signed URL that expires in about a minute.

## Why signaling lives in tables, not Supabase Realtime
Realtime broadcast channels accept anyone holding the public anon key. Using
them for WebRTC offers would let a participant inject their own offer and
play audio through the venue displays. Offers and answers are exchanged only
through authenticated API routes (admin session / display device token).

## Liveness
A live session records last_seen_at every time the admin's browser checks in.
Displays treat a session whose admin has gone quiet for 10s as ended, so a
closed laptop or expired session can't leave screens holding a dead stream.
*/

CREATE TABLE IF NOT EXISTS public.audio_broadcasts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('clip', 'live')),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  target            text NOT NULL,
  storage_path      text,
  mime_type         text,
  duration_seconds  numeric CHECK (duration_seconds IS NULL OR (duration_seconds > 0 AND duration_seconds <= 600)),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'cancelled')),
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- clip: when late-joining displays stop picking it up
  play_until        timestamptz,
  -- live: admin browser heartbeat
  last_seen_at      timestamptz,
  ended_at          timestamptz,
  CONSTRAINT audio_clip_has_file CHECK (kind <> 'clip' OR (storage_path IS NOT NULL AND play_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS audio_broadcasts_active_idx ON public.audio_broadcasts (status, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS public.live_audio_peers (
  broadcast_id  uuid NOT NULL REFERENCES public.audio_broadcasts (id) ON DELETE CASCADE,
  display_uuid  uuid NOT NULL REFERENCES public.event_displays (id) ON DELETE CASCADE,
  offer_sdp     text CHECK (offer_sdp IS NULL OR char_length(offer_sdp) <= 20000),
  answer_sdp    text CHECK (answer_sdp IS NULL OR char_length(answer_sdp) <= 20000),
  state         text NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'offered', 'answered', 'connected', 'failed', 'closed')),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (broadcast_id, display_uuid)
);
CREATE INDEX IF NOT EXISTS live_audio_peers_display_idx ON public.live_audio_peers (display_uuid, state);

ALTER TABLE public.audio_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_audio_peers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audio_broadcasts FROM anon, authenticated;
REVOKE ALL ON public.live_audio_peers FROM anon, authenticated;

-- Private bucket. With RLS on storage.objects and no policies for anon or
-- authenticated, only the service role can read or write.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'audio-broadcasts',
  'audio-broadcasts',
  false,
  10485760,
  ARRAY['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

NOTIFY pgrst, 'reload schema';
