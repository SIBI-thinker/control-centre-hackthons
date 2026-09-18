import { NextRequest } from 'next/server';
import { audit, invalidateAccount, requireSession } from '@/lib/server/auth';
import { invalidateParticipantContext } from '@/lib/server/participant';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson, requireString } from '@/lib/server/http';
import { assertOtherActiveAdminExists } from '@/lib/server/people';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/**
 * Edits an account: name, active flag, a participant's team, or an operator's
 * rooms. Deactivating signs the person out immediately (session_version bump).
 */
export const PATCH = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account: actor } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'account id');
  const body = await readJson<Record<string, unknown>>(req);
  const db = getServiceClient();

  const { data: target, error: lookupError } = await db
    .from('accounts')
    .select('id, account_id, role, active, session_version')
    .eq('id', id)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (!target) throw new HttpError(404, 'Account not found.');

  const updates: Record<string, unknown> = {};
  const changed: string[] = [];

  if (body.display_name !== undefined) {
    updates.display_name = requireString(body.display_name, 'Name', 120);
    changed.push('name');
  }

  if (typeof body.active === 'boolean' && body.active !== target.active) {
    if (!body.active) {
      if (target.id === actor.id) throw new HttpError(409, 'You cannot deactivate your own account.');
      if (target.role === 'admin') await assertOtherActiveAdminExists(target.id);
      updates.session_version = target.session_version + 1;
    }
    updates.active = body.active;
    changed.push(body.active ? 'activated' : 'deactivated');
  }

  if (body.team_id !== undefined) {
    if (target.role !== 'participant') throw new HttpError(400, 'Only participants belong to a team.');
    updates.team_id = parseUuid(body.team_id, 'team');
    changed.push('team');
  }

  let roomIds: string[] | null = null;
  if (body.room_ids !== undefined) {
    if (target.role !== 'operator') throw new HttpError(400, 'Only operators are assigned to rooms.');
    if (!Array.isArray(body.room_ids) || body.room_ids.length === 0) throw new HttpError(400, 'Assign the operator to at least one room.');
    roomIds = body.room_ids.map((r) => parseUuid(r, 'room'));
    changed.push('rooms');
  }

  if (changed.length === 0) throw new HttpError(400, 'Nothing to update.');

  if (Object.keys(updates).length > 0) {
    const { error } = await db.from('accounts').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) {
      if (error.code === '23503') throw new HttpError(400, 'That team no longer exists.');
      throw error;
    }
  }

  if (roomIds) {
    // Insert the new set first, then drop the rest — the operator is never
    // momentarily left with zero rooms.
    const { error: addError } = await db
      .from('operator_rooms')
      .upsert(roomIds.map((roomId) => ({ account_id: id, room_id: roomId })), { ignoreDuplicates: true });
    if (addError) {
      if (addError.code === '23503') throw new HttpError(400, 'One of the selected rooms no longer exists.');
      throw addError;
    }
    const { error: removeError } = await db
      .from('operator_rooms')
      .delete()
      .eq('account_id', id)
      .not('room_id', 'in', '(' + roomIds.join(',') + ')');
    if (removeError) throw removeError;
  }

  invalidateAccount(target.id);
  invalidateParticipantContext(target.id);
  await audit(actor.account_id, 'ACCOUNT_UPDATED', target.account_id, changed.join(', '));
  return json({ ok: true });
});

export const DELETE = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account: actor } = await requireSession(req, ['admin']);
  const id = parseUuid(params.id, 'account id');
  const db = getServiceClient();

  const { data: target, error: lookupError } = await db.from('accounts').select('id, account_id, role').eq('id', id).maybeSingle();
  if (lookupError) throw lookupError;
  if (!target) throw new HttpError(404, 'Account not found.');
  if (target.id === actor.id) throw new HttpError(409, 'You cannot delete your own account.');
  if (target.role === 'admin') await assertOtherActiveAdminExists(target.id);

  const { error } = await db.from('accounts').delete().eq('id', id);
  if (error) throw error;

  invalidateAccount(target.id);
  invalidateParticipantContext(target.id);
  await audit(actor.account_id, 'ACCOUNT_DELETED', target.account_id, target.role);
  return json({ ok: true });
});
