import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { loadEventState, updateEventState } from '@/lib/server/event';
import { handle, json, readJson } from '@/lib/server/http';
import { parseInteger } from '@/lib/server/validate';
import { calcRemaining, type EventControlState } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const WEEK = 7 * 24 * 60 * 60;

export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<{ seconds: number }>(req);
  const seconds = parseInteger(body.seconds, 'Adjustment', -WEEK, WEEK);

  const state = await loadEventState();
  const newRemaining = Math.max(0, calcRemaining(state, Date.now()) + seconds);

  const updates: Partial<EventControlState> = { remaining_seconds: newRemaining };
  if (state.timer_status === 'RUNNING') {
    updates.ends_at = new Date(Date.now() + newRemaining * 1000).toISOString();
  }

  await updateEventState(state.id, updates);
  await audit(
    account.account_id,
    'TIME_ADJUSTED',
    null,
    (seconds > 0 ? '+' : '') + Math.round(seconds / 60) + ' min — new remaining: ' + Math.round(newRemaining / 60) + 'm'
  );
  return json({ ok: true });
});
