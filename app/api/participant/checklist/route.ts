import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { loadParticipantContext } from '@/lib/server/participant';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

/**
 * Ticks or unticks a checklist item for the caller's team.
 *
 * Only items of the phase running in the team's room right now — a team can't
 * tick ahead into a phase that hasn't started, or rewrite a finished one.
 */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['participant']);
  const body = await readJson<{ item_id: string; checked: boolean }>(req);
  const itemId = parseUuid(body.item_id, 'checklist item');
  if (typeof body.checked !== 'boolean') throw new HttpError(400, 'Say whether the item is checked.');

  const ctx = await loadParticipantContext(account.id);
  if (!ctx.roomId) throw new HttpError(403, 'Your team has no room yet, so there is no active phase.');

  const db = getServiceClient();
  const { data: item, error } = await db.from('phase_checklist_items').select('id, phase_id').eq('id', itemId).maybeSingle();
  if (error) throw error;
  if (!item) throw new HttpError(404, 'That checklist item no longer exists.');

  const [{ data: phase, error: phaseError }, { data: link, error: linkError }] = await Promise.all([
    db.from('phases').select('starts_at, ends_at').eq('id', item.phase_id).maybeSingle(),
    db.from('phase_rooms').select('room_id').eq('phase_id', item.phase_id).eq('room_id', ctx.roomId).maybeSingle(),
  ]);
  if (phaseError) throw phaseError;
  if (linkError) throw linkError;
  if (!phase || !link) throw new HttpError(403, 'That item is not part of your room’s phase.');

  const now = Date.now();
  if (now < new Date(phase.starts_at).getTime()) throw new HttpError(409, 'This phase has not started yet.');
  if (now >= new Date(phase.ends_at).getTime()) throw new HttpError(409, 'This phase has ended.');

  if (body.checked) {
    const { error: upsertError } = await db
      .from('team_checklist_progress')
      .upsert({ team_id: ctx.teamId, item_id: itemId, checked_by: account.account_id, checked_at: new Date().toISOString() }, { onConflict: 'team_id,item_id', ignoreDuplicates: true }); // keep who ticked it first
    if (upsertError) throw upsertError;
  } else {
    const { error: deleteError } = await db.from('team_checklist_progress').delete().eq('team_id', ctx.teamId).eq('item_id', itemId);
    if (deleteError) throw deleteError;
  }

  return json({ ok: true });
});
