import 'server-only';
import { getServiceClient } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import type { EventControlState } from '@/lib/supabase';

/**
 * Loads the single event state row. Timer maths always runs against this
 * server-side copy — never against a state object the browser sent, which
 * could be stale or edited.
 */
export async function loadEventState(): Promise<EventControlState> {
  const { data, error } = await getServiceClient().from('event_control_state').select('*').limit(1).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(500, 'Event state is missing.');
  return data as EventControlState;
}

export async function updateEventState(id: string, updates: Partial<EventControlState>) {
  const { error } = await getServiceClient()
    .from('event_control_state')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
