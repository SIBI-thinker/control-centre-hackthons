import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson, requireString } from '@/lib/server/http';
import { isUniqueViolation, parseCode, parseUuid } from '@/lib/server/validate';
import { invalidateAllParticipantContexts } from '@/lib/server/participant';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

export const PATCH = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'team id');
  const body = await readJson<Record<string, unknown>>(req);

  const updates: Record<string, string | null> = {};
  if (body.name !== undefined) updates.name = requireString(body.name, 'Team name', 80);
  if (body.code !== undefined) updates.code = parseCode(body.code, 'Team code', false);
  if (body.room_id !== undefined) updates.room_id = body.room_id ? parseUuid(body.room_id, 'room id') : null;
  if (Object.keys(updates).length === 0) throw new HttpError(400, 'Nothing to update.');

  const { data, error } = await getServiceClient()
    .from('teams')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('code')
    .maybeSingle();
  if (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'That team code is already in use. Names may repeat, codes may not.');
    if (error.code === '23503') throw new HttpError(400, 'That room no longer exists.');
    throw error;
  }
  if (!data) throw new HttpError(404, 'Team not found.');

  invalidateAllParticipantContexts();
  await audit(account.account_id, 'TEAM_UPDATED', data.code, Object.keys(updates).join(', '));
  return json({ ok: true });
});

export const DELETE = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'team id');

  const { data, error } = await getServiceClient().from('teams').delete().eq('id', id).select('code').maybeSingle();
  if (error) {
    // accounts.team_id is ON DELETE RESTRICT.
    if (error.code === '23503') throw new HttpError(409, 'This team still has participants. Move or delete them first.');
    throw error;
  }
  if (!data) throw new HttpError(404, 'Team not found.');

  await audit(account.account_id, 'TEAM_DELETED', data.code, null);
  return json({ ok: true });
});
