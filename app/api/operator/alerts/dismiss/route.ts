import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { loadOperatorRooms } from '@/lib/server/operator';
import { parseUuid } from '@/lib/server/validate';
import { roomTarget } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/** Takes a room alert off air — only alerts aimed at the operator's own rooms. */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['operator']);
  const body = await readJson<{ id: string }>(req);
  const id = parseUuid(body.id, 'alert id');

  const rooms = await loadOperatorRooms(account.id);
  if (rooms.length === 0) throw new HttpError(403, 'You have no rooms assigned.');

  const { data, error } = await getServiceClient()
    .from('event_alerts')
    .update({ execution_status: 'CANCELLED' })
    .eq('id', id)
    .eq('execution_status', 'EXECUTED')
    .in('target', rooms.map((r) => roomTarget(r.id)))
    .select('title, target')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'That alert is not live in one of your rooms.');

  const room = rooms.find((r) => roomTarget(r.id) === data.target);
  await audit(account.account_id, 'ROOM_ALERT_DISMISSED', room ? room.code : data.target, data.title);
  return json({ ok: true });
});
