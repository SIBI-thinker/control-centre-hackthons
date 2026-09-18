import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { assertOperatesRoom, loadOperatorRooms } from '@/lib/server/operator';
import { parseAlert } from '@/lib/server/validate';
import { formatDurationLabel, ROOM_TARGET_PREFIX, roomTarget } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Operators may broadcast only to their own rooms' displays, and for at most
 * an hour — long, venue-shaping notices (lunch, schedule changes) stay with
 * the core team.
 */
const OPERATOR_MAX_SECONDS = 60 * 60;

/** Live and recent alerts aimed at the operator's rooms. */
export const GET = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['operator']);
  const rooms = await loadOperatorRooms(account.id);
  if (rooms.length === 0) return json({ alerts: [] });

  const { data, error } = await getServiceClient()
    .from('event_alerts')
    .select('id, title, message, message_type, duration_seconds, target, execution_status, executed_at, created_by, created_at')
    .in('target', rooms.map((r) => roomTarget(r.id)))
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  return json({ alerts: data ?? [] });
});

export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['operator']);
  const body = await readJson<Record<string, unknown>>(req);
  const alert = parseAlert(body);

  if (!alert.target.startsWith(ROOM_TARGET_PREFIX)) throw new HttpError(403, 'Operators can only send alerts to a room.');
  const rooms = await loadOperatorRooms(account.id);
  assertOperatesRoom(rooms, alert.target.slice(ROOM_TARGET_PREFIX.length));
  if (alert.duration > OPERATOR_MAX_SECONDS) throw new HttpError(400, 'Room alerts from operators can last at most 1 hour.');

  const { data, error } = await getServiceClient()
    .from('event_alerts')
    .insert({
      title: alert.title,
      message: alert.message,
      message_type: alert.type,
      animation: alert.animation,
      duration_seconds: alert.duration,
      target: alert.target,
      scheduled_for: null,
      execution_status: 'EXECUTED',
      executed_at: new Date().toISOString(),
      created_by: account.account_id,
    })
    .select('id')
    .single();
  if (error) throw error;

  const room = rooms.find((r) => alert.target === roomTarget(r.id));
  await audit(account.account_id, 'ROOM_ALERT_SENT', room ? room.code : alert.target, alert.title + ' (' + formatDurationLabel(alert.duration) + ')');
  return json({ id: data.id });
});
