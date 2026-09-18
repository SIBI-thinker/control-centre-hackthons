import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson, requireString } from '@/lib/server/http';
import { isUniqueViolation, optionalText, parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/** Edits a login, or changes who it belongs to (null unassigns it). */
export const PATCH = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'credential id');
  const body = await readJson<Record<string, unknown>>(req);

  const updates: Record<string, unknown> = {};
  if (body.username !== undefined) updates.username = requireString(body.username, 'Username', 120);
  if (body.password !== undefined) updates.password = requireString(body.password, 'Password', 120);
  if (body.label !== undefined) updates.label = optionalText(body.label, 120);

  if (body.assigned_team_id !== undefined) {
    updates.assigned_team_id = body.assigned_team_id ? parseUuid(body.assigned_team_id, 'team') : null;
    if (updates.assigned_team_id) updates.assigned_account_id = null;
  }
  if (body.assigned_account_id !== undefined) {
    updates.assigned_account_id = body.assigned_account_id ? parseUuid(body.assigned_account_id, 'participant') : null;
    if (updates.assigned_account_id) updates.assigned_team_id = null;
  }
  if (Object.keys(updates).length === 0) throw new HttpError(400, 'Nothing to update.');

  const { data, error } = await getServiceClient()
    .from('wifi_credentials')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('username')
    .maybeSingle();
  if (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'That username, team or participant already has a login.');
    if (error.code === '23503') throw new HttpError(400, 'That team or participant no longer exists.');
    throw error;
  }
  if (!data) throw new HttpError(404, 'Login not found.');

  await audit(account.account_id, 'WIFI_LOGIN_UPDATED', data.username, Object.keys(updates).join(', '));
  return json({ ok: true });
});

export const DELETE = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'credential id');

  const { data, error } = await getServiceClient().from('wifi_credentials').delete().eq('id', id).select('username').maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Login not found.');

  await audit(account.account_id, 'WIFI_LOGIN_DELETED', data.username, null);
  return json({ ok: true });
});
