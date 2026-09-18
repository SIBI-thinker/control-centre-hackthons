import 'server-only';
import { getServiceClient } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';

export type OperatorRoom = { id: string; code: string; name: string; location: string | null };

/** The rooms an operator is assigned to. Everything operator-scoped starts here. */
export async function loadOperatorRooms(accountUuid: string): Promise<OperatorRoom[]> {
  const db = getServiceClient();
  const { data: links, error } = await db.from('operator_rooms').select('room_id').eq('account_id', accountUuid);
  if (error) throw error;
  const ids = (links ?? []).map((l) => l.room_id);
  if (ids.length === 0) return [];
  const { data: rooms, error: roomsError } = await db.from('rooms').select('id, code, name, location').in('id', ids).order('code');
  if (roomsError) throw roomsError;
  return rooms ?? [];
}

export function assertOperatesRoom(rooms: OperatorRoom[], roomId: string) {
  if (!rooms.some((r) => r.id === roomId)) throw new HttpError(403, 'You can only act on rooms you operate.');
}
