import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

export const PATCH = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'display id');
  const body = await readJson<Record<string, unknown>>(req);

  const updates: Record<string, string | boolean | null> = {};
  if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;
  if (body.room_id !== undefined) {
    updates.room_id = body.room_id === null || body.room_id === '' ? null : parseUuid(body.room_id, 'room id');
  }
  if (typeof body.batch === 'string' && body.batch.trim()) updates.batch = body.batch.trim().slice(0, 60);
  if (typeof body.display_name === 'string' && body.display_name.trim()) updates.display_name = body.display_name.trim().slice(0, 80);
  if (typeof body.location === 'string' && body.location.trim()) updates.location = body.location.trim().slice(0, 80);
  if (Object.keys(updates).length === 0) throw new HttpError(400, 'Nothing to update.');

  const { data, error } = await getServiceClient()
    .from('event_displays')
    .update(updates)
    .eq('id', id)
    .select('display_id')
    .maybeSingle();
  if (error) {
    if (error.code === '23503') throw new HttpError(400, 'That room no longer exists.');
    throw error;
  }
  if (!data) throw new HttpError(404, 'Display not found.');

  const summary = Object.keys(updates).map((k) => k + '=' + updates[k]).join(', ');
  await audit(account.account_id, 'enabled' in updates && Object.keys(updates).length === 1 ? 'DISPLAY_TOGGLED' : 'DISPLAY_UPDATED', data.display_id, summary);
  return json({ ok: true });
});

export const DELETE = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'display id');

  // display_credentials rows cascade, so the kiosk's device token dies with it.
  const { data, error } = await getServiceClient()
    .from('event_displays')
    .delete()
    .eq('id', id)
    .select('display_id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Display not found.');

  await audit(account.account_id, 'DISPLAY_DELETED', data.display_id, 'Removed from registry');
  return json({ ok: true });
});
