import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

/**
 * Takes one or more live broadcasts off air by cancelling their rows — the
 * rows are what displays read. Scoped to EXECUTED rows so a double-click or a
 * second operator can't re-cancel something that already ended.
 */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<{ ids: unknown[] }>(req);

  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 100) {
    throw new HttpError(400, 'Provide between 1 and 100 alert ids.');
  }
  const ids = body.ids.map((id) => parseUuid(id, 'alert id'));

  const { data, error } = await getServiceClient()
    .from('event_alerts')
    .update({ execution_status: 'CANCELLED' })
    .in('id', ids)
    .eq('execution_status', 'EXECUTED')
    .select('id, title, target');
  if (error) throw error;

  const cleared = data ?? [];
  if (cleared.length === 1) {
    await audit(account.account_id, 'ALERT_DISMISSED', cleared[0].target, cleared[0].title);
  } else if (cleared.length > 1) {
    await audit(account.account_id, 'ALERT_DISMISSED', 'MULTIPLE', cleared.length + ' broadcasts cleared');
  }

  return json({ cleared: cleared.length });
});
