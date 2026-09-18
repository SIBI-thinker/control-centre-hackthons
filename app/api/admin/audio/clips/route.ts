import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import {
  AUDIO_BUCKET,
  CLIP_LATE_JOIN_MS,
  extensionFor,
  MAX_CLIP_BYTES,
  MAX_CLIP_SECONDS,
  onlineTargetedDisplays,
  sniffAudioType,
} from '@/lib/server/audio';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json } from '@/lib/server/http';
import { parseTarget } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

/**
 * Uploads a recorded clip and broadcasts it (multipart form: file, title,
 * target, duration). Displays online now — or within a minute — play it once.
 */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, 'Expected an audio upload.');
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'No audio file received.');
  if (file.size === 0) throw new HttpError(400, 'The recording is empty.');
  if (file.size > MAX_CLIP_BYTES) throw new HttpError(400, 'Recordings must be under 10 MB.');

  const title = String(form.get('title') ?? '').trim();
  if (!title) throw new HttpError(400, 'Give the announcement a title.');
  if (title.length > 120) throw new HttpError(400, 'Title must be at most 120 characters.');

  const target = parseTarget(form.get('target'));

  const duration = Number(form.get('duration'));
  if (!Number.isFinite(duration) || duration <= 0) throw new HttpError(400, 'Recording length is missing.');
  if (duration > MAX_CLIP_SECONDS) throw new HttpError(400, 'Recordings can be at most ' + MAX_CLIP_SECONDS / 60 + ' minutes.');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffAudioType(bytes);
  if (!mime) throw new HttpError(400, 'That file is not a supported audio recording.');

  const db = getServiceClient();
  const path = new Date().toISOString().slice(0, 10) + '/' + randomUUID() + '.' + extensionFor(mime);

  const { error: uploadError } = await db.storage.from(AUDIO_BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
  if (uploadError) {
    if (/bucket not found/i.test(uploadError.message)) {
      throw new HttpError(503, 'Audio storage is not set up. Run the audio broadcasts migration.');
    }
    throw uploadError;
  }

  // Playable until the clip would have finished for a display joining late.
  const playUntil = new Date(Date.now() + duration * 1000 + CLIP_LATE_JOIN_MS).toISOString();

  const { data, error } = await db
    .from('audio_broadcasts')
    .insert({
      kind: 'clip',
      title,
      target,
      storage_path: path,
      mime_type: mime,
      duration_seconds: Math.round(duration * 10) / 10,
      created_by: account.account_id,
      play_until: playUntil,
    })
    .select('id')
    .single();
  if (error) {
    await db.storage.from(AUDIO_BUCKET).remove([path]);
    throw error;
  }

  const reached = await onlineTargetedDisplays(target);
  await audit(account.account_id, 'AUDIO_CLIP_SENT', target, title + ' (' + Math.round(duration) + 's) → ' + reached.length + ' online display(s)');

  return json({ id: data.id, reached: reached.length });
});
