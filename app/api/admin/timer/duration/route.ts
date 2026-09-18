import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { loadEventState, updateEventState } from '@/lib/server/event';
import { handle, json, readJson } from '@/lib/server/http';
import { parseInteger } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<{ seconds: number }>(req);
  const seconds = parseInteger(body.seconds, 'Duration', 60, 30 * 24 * 60 * 60);

  const state = await loadEventState();
  await updateEventState(state.id, {
    duration_seconds: seconds,
    remaining_seconds: seconds,
    timer_status: 'NOT_STARTED',
    started_at: null,
    paused_at: null,
    ends_at: null,
  });

  await audit(account.account_id, 'DURATION_CONFIGURED', null, 'Event duration set to ' + Math.round(seconds / 3600) + 'h');
  return json({ ok: true });
});
