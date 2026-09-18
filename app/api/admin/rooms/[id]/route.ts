import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson, requireString } from '@/lib/server/http';
import { isUniqueViolation, optionalText, parseCode, parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

export const PATCH = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'room id');
  const body = await readJson<Record<string, unknown>>(req);

  const updates: Record<string, string | null> = {};
  if (body.code !== undefined) updates.code = parseCode(body.code, 'Room code', true);
  if (body.name !== undefined) updates.name = requireString(body.name, 'Room name', 80);
  if (body.location !== undefined) updates.location = optionalText(body.location, 120);
  if (Object.keys(updates).length === 0) throw new HttpError(400, 'Nothing to update.');

  const { data, error } = await getServiceClient()
    .from('rooms')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('code')
    .maybeSingle();
  if (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'Room code ' + updates.code + ' already exists.');
    throw error;
  }
  if (!data) throw new HttpError(404, 'Room not found.');

  await audit(account.account_id, 'ROOM_UPDATED', data.code, Object.keys(updates).join(', '));
  return json({ ok: true });
});

/**
 * Deletes a room. Its displays and teams stay but become unassigned; operator
 * assignments and phase links to it are removed.
 */
export const DELETE = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'room id');

  const { data, error } = await getServiceClient().from('rooms').delete().eq('id', id).select('code').maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Room not found.');

  await audit(account.account_id, 'ROOM_DELETED', data.code, 'Displays and teams unassigned');
  return json({ ok: true });
});
