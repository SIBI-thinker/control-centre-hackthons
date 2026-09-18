import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { CLIP_LATE_JOIN_MS, onlineTargetedDisplays } from '@/lib/server/audio';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { parseTarget, parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/**
 * Plays an earlier clip again, optionally to a different target. Creates a new
 * broadcast pointing at the same stored file, so displays treat it as new.
 */
export const POST = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'broadcast id');
  const body = await readJson<{ target?: string }>(req);
  const db = getServiceClient();

  const { data: original, error } = await db
    .from('audio_broadcasts')
    .select('kind, title, target, storage_path, mime_type, duration_seconds')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!original) throw new HttpError(404, 'Recording not found.');
  if (original.kind !== 'clip' || !original.storage_path) throw new HttpError(400, 'Only recorded clips can be replayed.');

  const target = body.target ? parseTarget(body.target) : original.target;
  const duration = Number(original.duration_seconds) || 30;

  const { data, error: insertError } = await db
    .from('audio_broadcasts')
    .insert({
      kind: 'clip',
      title: original.title,
      target,
      storage_path: original.storage_path,
      mime_type: original.mime_type,
      duration_seconds: original.duration_seconds,
      created_by: account.account_id,
      play_until: new Date(Date.now() + duration * 1000 + CLIP_LATE_JOIN_MS).toISOString(),
    })
    .select('id')
    .single();
  if (insertError) throw insertError;

  const reached = await onlineTargetedDisplays(target);
  await audit(account.account_id, 'AUDIO_CLIP_REPLAYED', target, original.title + ' → ' + reached.length + ' online display(s)');
  return json({ id: data.id, reached: reached.length });
});
