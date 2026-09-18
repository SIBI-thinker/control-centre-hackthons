import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, json, readJson } from '@/lib/server/http';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

/** Cancels a queued (PENDING) alert before it fires. */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<{ id: string }>(req);
  const id = parseUuid(body.id, 'alert id');

  const { data, error } = await getServiceClient()
    .from('event_alerts')
    .update({ execution_status: 'CANCELLED' })
    .eq('id', id)
    .eq('execution_status', 'PENDING')
    .select('title')
    .maybeSingle();
  if (error) throw error;

  if (data) await audit(account.account_id, 'ALERT_CANCELLED', 'SCHEDULE', data.title);
  return json({ cancelled: Boolean(data) });
});
