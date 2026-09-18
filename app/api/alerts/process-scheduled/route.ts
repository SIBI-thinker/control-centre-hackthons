import { NextRequest } from 'next/server';
import { audit } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/**
 * Fires scheduled alerts whose time has come.
 *
 * Intentionally unauthenticated: displays call it on a timer, since there is
 * no background worker. It is safe to expose because it can only execute
 * alerts an admin already queued AND whose scheduled time has passed — calling
 * it early, often, or maliciously changes nothing.
 *
 * The conditional update (still PENDING) makes it idempotent: when several
 * displays call at once, exactly one wins each row.
 */

// Crude per-instance throttle so a flood of calls can't hammer the database.
let lastRunAt = 0;

export const POST = handle(async (_req: NextRequest) => {
  if (Date.now() - lastRunAt < 2000) return json({ executed: 0, throttled: true });
  lastRunAt = Date.now();

  const db = getServiceClient();
  const nowIso = new Date().toISOString();

  const { data: due, error } = await db
    .from('event_alerts')
    .select('id')
    .eq('execution_status', 'PENDING')
    .lte('scheduled_for', nowIso)
    .limit(20);
  if (error) throw error;
  if (!due || due.length === 0) return json({ executed: 0 });

  let executed = 0;
  for (const row of due) {
    const { data: fired, error: fireError } = await db
      .from('event_alerts')
      .update({ execution_status: 'EXECUTED', executed_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('execution_status', 'PENDING')
      .select('title, target')
      .maybeSingle();
    if (fireError) throw fireError;
    if (fired) {
      executed++;
      await audit('SYSTEM', 'SCHEDULED_ALERT_TRIGGERED', fired.target, fired.title);
    }
  }

  return json({ executed });
});
