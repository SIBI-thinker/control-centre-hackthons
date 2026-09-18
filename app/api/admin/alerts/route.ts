import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { parseAlert } from '@/lib/server/validate';
import { formatDurationLabel } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Sends a broadcast now, or queues it when `scheduledFor` is given.
 *
 * Displays read live alerts straight from `event_alerts`, so inserting an
 * EXECUTED row is the broadcast. The old single-slot
 * `event_control_state.active_alert` mirror is no longer written.
 */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<Record<string, unknown>>(req);
  const alert = parseAlert(body);

  let scheduledFor: string | null = null;
  if (body.scheduledFor !== undefined && body.scheduledFor !== null && body.scheduledFor !== '') {
    const when = new Date(String(body.scheduledFor));
    if (isNaN(when.getTime())) throw new HttpError(400, 'Invalid schedule time.');
    if (when.getTime() < Date.now() - 60_000) throw new HttpError(400, 'Schedule time is in the past.');
    scheduledFor = when.toISOString();
  }

  const nowIso = new Date().toISOString();
  const { data, error } = await getServiceClient()
    .from('event_alerts')
    .insert({
      title: alert.title,
      message: alert.message,
      message_type: alert.type,
      animation: alert.animation,
      duration_seconds: alert.duration,
      target: alert.target,
      scheduled_for: scheduledFor,
      execution_status: scheduledFor ? 'PENDING' : 'EXECUTED',
      executed_at: scheduledFor ? null : nowIso,
      created_by: account.account_id,
    })
    .select('id')
    .maybeSingle();
  if (error) throw error;

  if (scheduledFor) {
    await audit(account.account_id, 'ALERT_SCHEDULED', alert.target, alert.title + ' — scheduled for ' + scheduledFor);
  } else {
    await audit(account.account_id, 'ALERT_SENT', alert.target, alert.title + ' (' + formatDurationLabel(alert.duration) + ')');
  }

  return json({ id: data?.id ?? null });
});
