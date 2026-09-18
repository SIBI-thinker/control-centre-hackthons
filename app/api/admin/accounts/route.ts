import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson, requireString } from '@/lib/server/http';
import { assertAccountId, assertAccountIdsFree, ID_PREFIX, issuePins, nextSequentialIds, normalizeAccountId } from '@/lib/server/people';
import { hashPin, validatePin } from '@/lib/server/pin';
import { parseUuid } from '@/lib/server/validate';
import type { AccountSummary, IssuedCredential, Role } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const ROLES: Role[] = ['admin', 'operator', 'participant'];

/** Every account, without credentials. */
export const GET = handle(async (req: NextRequest) => {
  await requireSession(req, ['admin']);
  const db = getServiceClient();

  const [accounts, operatorRooms] = await Promise.all([
    db.from('accounts').select('id, account_id, role, display_name, active, team_id, last_login_at, created_at').order('account_id'),
    db.from('operator_rooms').select('account_id, room_id'),
  ]);
  if (accounts.error) throw accounts.error;
  if (operatorRooms.error) throw operatorRooms.error;

  const roomsByAccount: Record<string, string[]> = {};
  (operatorRooms.data ?? []).forEach((row) => {
    (roomsByAccount[row.account_id] = roomsByAccount[row.account_id] || []).push(row.room_id);
  });

  const result: AccountSummary[] = (accounts.data ?? []).map((a) => ({ ...a, room_ids: roomsByAccount[a.id] ?? [] }));
  return json({ accounts: result });
});

/**
 * Creates one account. The PIN is generated unless one is supplied, and is
 * returned exactly once in the response.
 */
export const POST = handle(async (req: NextRequest) => {
  const { account: actor } = await requireSession(req, ['admin']);
  const body = await readJson<Record<string, unknown>>(req);
  const db = getServiceClient();

  const role = body.role as Role;
  if (ROLES.indexOf(role) === -1) throw new HttpError(400, 'Invalid role.');
  const displayName = requireString(body.display_name, 'Name', 120);

  let accountId = normalizeAccountId(body.account_id);
  if (accountId) {
    assertAccountId(accountId);
    await assertAccountIdsFree([accountId]);
  } else {
    accountId = (await nextSequentialIds('accounts', 'account_id', ID_PREFIX[role].prefix, 1, ID_PREFIX[role].pad))[0];
  }

  let teamId: string | null = null;
  let teamName: string | null = null;
  let roomLabel: string | null = null;
  if (role === 'participant') {
    teamId = parseUuid(body.team_id, 'team');
    const { data: team, error } = await db.from('teams').select('name, room_id').eq('id', teamId).maybeSingle();
    if (error) throw error;
    if (!team) throw new HttpError(400, 'That team no longer exists.');
    teamName = team.name;
    if (team.room_id) {
      const { data: room } = await db.from('rooms').select('code, name').eq('id', team.room_id).maybeSingle();
      if (room) roomLabel = room.code + ' · ' + room.name;
    }
  }

  let roomIds: string[] = [];
  if (role === 'operator') {
    roomIds = Array.isArray(body.room_ids) ? body.room_ids.map((r) => parseUuid(r, 'room')) : [];
    if (roomIds.length === 0) throw new HttpError(400, 'Assign the operator to at least one room.');
  }

  let pin: string;
  let pinHash: string;
  if (typeof body.pin === 'string' && body.pin.trim()) {
    const problem = validatePin(body.pin.trim());
    if (problem) throw new HttpError(400, problem);
    pin = body.pin.trim();
    pinHash = await hashPin(pin);
  } else {
    const [issued] = await issuePins(1);
    pin = issued.pin;
    pinHash = issued.hash;
  }

  const { data: created, error } = await db
    .from('accounts')
    .insert({ account_id: accountId, role, display_name: displayName, pin_hash: pinHash, team_id: teamId })
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') throw new HttpError(409, accountId + ' is already in use.');
    throw error;
  }

  if (roomIds.length > 0) {
    const { error: roomError } = await db.from('operator_rooms').insert(roomIds.map((roomId) => ({ account_id: created.id, room_id: roomId })));
    if (roomError) {
      // Don't leave an operator with no rooms behind.
      await db.from('accounts').delete().eq('id', created.id);
      if (roomError.code === '23503') throw new HttpError(400, 'One of the selected rooms no longer exists.');
      throw roomError;
    }
  }

  await audit(actor.account_id, 'ACCOUNT_CREATED', accountId, role + ' · ' + displayName);

  const credential: IssuedCredential = { account_id: accountId, display_name: displayName, role, pin, team_name: teamName, room_label: roomLabel };
  return json({ credential });
});
