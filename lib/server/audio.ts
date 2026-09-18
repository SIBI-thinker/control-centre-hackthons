import 'server-only';
import { getServiceClient } from '@/lib/server/db';
import { isTargetedAt, type EventDisplay } from '@/lib/supabase';

export const AUDIO_BUCKET = 'audio-broadcasts';
export const MAX_CLIP_BYTES = 10 * 1024 * 1024;
export const MAX_CLIP_SECONDS = 180;

/** A display counts as online if it has sent a heartbeat this recently. */
export const ONLINE_WINDOW_MS = 35_000;
/** A live session whose admin hasn't checked in for this long is dead. */
export const LIVE_STALE_MS = 10_000;
/** Late-joining displays may still start a clip this long after it was sent. */
export const CLIP_LATE_JOIN_MS = 60_000;
/** Signed URLs for clips expire quickly; a display fetches a fresh one per play. */
export const CLIP_URL_TTL_SECONDS = 90;

/**
 * STUN lets browsers find a direct path to each other. Venue networks that
 * isolate devices need a TURN relay as well — set TURN_URL, TURN_USERNAME and
 * TURN_CREDENTIAL to add one (e.g. Cloudflare TURN) without code changes.
 */
export function iceServers(): RTCIceServerConfig[] {
  const servers: RTCIceServerConfig[] = [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
  ];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({
      urls: process.env.TURN_URL.split(',').map((u) => u.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return servers;
}

export type RTCIceServerConfig = { urls: string | string[]; username?: string; credential?: string };

/**
 * Identifies an audio file from its first bytes. The browser-supplied MIME
 * type is only a label — this checks the content really is audio we can play,
 * so nothing else gets stored and served from the bucket.
 */
export function sniffAudioType(bytes: Uint8Array): string | null {
  const ascii = (start: number, length: number) => String.fromCharCode.apply(null, Array.from(bytes.subarray(start, start + length)));

  if (bytes.length < 12) return null;
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'audio/webm'; // EBML (WebM/Matroska)
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(4, 4) === 'ftyp') return 'audio/mp4'; // Safari's MediaRecorder output
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    // MPEG audio frame sync; 0xF0/0xF1 layer bits are AAC ADTS.
    return (bytes[1] & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg';
  }
  return null;
}

export function extensionFor(mime: string): string {
  return ({ 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac' } as Record<string, string>)[mime] || 'bin';
}

/** Enabled, recently-heartbeating displays that a target reaches. */
export async function onlineTargetedDisplays(target: string): Promise<EventDisplay[]> {
  const { data, error } = await getServiceClient().from('event_displays').select('*').eq('enabled', true);
  if (error) throw error;
  const now = Date.now();
  return ((data ?? []) as EventDisplay[]).filter(
    (d) => d.last_heartbeat_at && now - new Date(d.last_heartbeat_at).getTime() < ONLINE_WINDOW_MS && isTargetedAt(target, d)
  );
}
