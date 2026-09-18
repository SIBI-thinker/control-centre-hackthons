import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { loadEventState, updateEventState } from '@/lib/server/event';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import type { EventControlState } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export const PATCH = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<Record<string, unknown>>(req);

  const updates: Partial<EventControlState> = {};
  if (typeof body.event_name === 'string' && body.event_name.trim()) updates.event_name = body.event_name.trim().slice(0, 80);
  if (typeof body.organization === 'string' && body.organization.trim()) updates.organization = body.organization.trim().slice(0, 120);
  if (typeof body.sound_enabled === 'boolean') updates.sound_enabled = body.sound_enabled;
  if (Object.keys(updates).length === 0) throw new HttpError(400, 'Nothing to update.');

  const state = await loadEventState();
  await updateEventState(state.id, updates);
  await audit(account.account_id, 'SETTINGS_UPDATED', null, Object.keys(updates).join(', '));
  return json({ ok: true });
});
