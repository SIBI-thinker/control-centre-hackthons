import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { loadEventState, updateEventState } from '@/lib/server/event';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { calcRemaining, type EventControlState } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const ACTIONS = ['start', 'pause', 'resume', 'reset'] as const;
type Action = typeof ACTIONS[number];

export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<{ action: string }>(req);
  const action = body.action as Action;
  if (ACTIONS.indexOf(action) === -1) throw new HttpError(400, 'Invalid timer action.');

  const state = await loadEventState();
  const nowIso = new Date().toISOString();
  // Remaining time is computed here from the stored end time, not supplied by
  // the browser, so a lagging or tampered client can't shift the clock.
  const remaining = calcRemaining(state, Date.now());

  let updates: Partial<EventControlState>;
  if (action === 'start' || action === 'resume') {
    if (state.timer_status === 'RUNNING') throw new HttpError(409, 'The timer is already running.');
    updates = {
      timer_status: 'RUNNING',
      ends_at: new Date(Date.now() + remaining * 1000).toISOString(),
      remaining_seconds: remaining,
      started_at: state.started_at || nowIso,
      paused_at: null,
    };
  } else if (action === 'pause') {
    if (state.timer_status !== 'RUNNING') throw new HttpError(409, 'The timer is not running.');
    updates = { timer_status: 'PAUSED', remaining_seconds: remaining, paused_at: nowIso, ends_at: null };
  } else {
    updates = {
      timer_status: 'NOT_STARTED',
      remaining_seconds: state.duration_seconds,
      ends_at: null,
      started_at: null,
      paused_at: null,
    };
  }

  await updateEventState(state.id, updates);
  await audit(account.account_id, 'TIMER_' + action.toUpperCase(), null, 'Status changed to ' + updates.timer_status);
  return json({ ok: true });
});
