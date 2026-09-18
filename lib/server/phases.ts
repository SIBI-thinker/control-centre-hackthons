import 'server-only';
import { getServiceClient } from '@/lib/server/db';
import { cached, invalidate } from '@/lib/server/cache';

export type PhaseFieldOption = { id: string; label: string; body: string; position: number };
export type PhaseField = {
  id: string;
  kind: 'text' | 'choice';
  label: string;
  help: string;
  required: boolean;
  max_length: number;
  position: number;
  options: PhaseFieldOption[];
};

export type PhaseRecord = {
  id: string;
  title: string;
  requirements: string;
  starts_at: string;
  ends_at: string;
  created_by: string | null;
  room_ids: string[];
  items: { id: string; label: string; position: number }[];
  fields: PhaseField[];
};

/** A phase's form is only editable while the phase is running. */
export function phaseIsOpen(phase: { starts_at: string; ends_at: string }, now: number): boolean {
  return new Date(phase.starts_at).getTime() <= now && now < new Date(phase.ends_at).getTime();
}

/**
 * Every participant in a room asks for exactly the same phases. Holding the
 * answer for a few seconds turns 2000 identical reads into one per room, and a
 * phase edit calls `invalidatePhases` so the console never looks stale.
 */
const PHASE_CACHE_MS = 5000;

export function invalidatePhases() {
  invalidate('phases:');
}

/** Loads phases with their rooms and ordered checklist items. */
export async function loadPhases(
  filter?: { roomId?: string; phaseIds?: string[] }
): Promise<PhaseRecord[]> {
  const key = 'phases:' + (filter?.roomId ? 'room:' + filter.roomId : filter?.phaseIds ? 'ids:' + filter.phaseIds.join(',') : 'all');
  return cached(key, PHASE_CACHE_MS, () => loadPhasesUncached(filter));
}

async function loadPhasesUncached(filter?: { roomId?: string; phaseIds?: string[] }): Promise<PhaseRecord[]> {
  const db = getServiceClient();

  let phaseIds: string[] | null = filter?.phaseIds ?? null;
  if (filter?.roomId) {
    const { data, error } = await db.from('phase_rooms').select('phase_id').eq('room_id', filter.roomId);
    if (error) throw error;
    phaseIds = (data ?? []).map((r) => r.phase_id);
    if (phaseIds.length === 0) return [];
  }

  let phaseQuery = db.from('phases').select('*').order('starts_at');
  if (phaseIds) phaseQuery = phaseQuery.in('id', phaseIds);
  const { data: phases, error } = await phaseQuery;
  if (error) throw error;
  if (!phases || phases.length === 0) return [];

  const ids = phases.map((p) => p.id);
  const [rooms, items, fields] = await Promise.all([
    db.from('phase_rooms').select('phase_id, room_id').in('phase_id', ids),
    db.from('phase_checklist_items').select('id, phase_id, label, position').in('phase_id', ids).order('position'),
    db.from('phase_fields').select('id, phase_id, kind, label, help, required, max_length, position').in('phase_id', ids).order('position'),
  ]);
  if (rooms.error) throw rooms.error;
  if (items.error) throw items.error;
  if (fields.error) throw fields.error;

  // Options are only fetched for the fields that have any, so a phase of plain
  // text questions costs nothing extra.
  const choiceFieldIds = (fields.data ?? []).filter((f) => f.kind === 'choice').map((f) => f.id);
  let options: { id: string; field_id: string; label: string; body: string; position: number }[] = [];
  if (choiceFieldIds.length > 0) {
    const { data, error: optionsError } = await db
      .from('phase_field_options')
      .select('id, field_id, label, body, position')
      .in('field_id', choiceFieldIds)
      .order('position');
    if (optionsError) throw optionsError;
    options = data ?? [];
  }

  return phases.map((p) => ({
    ...p,
    room_ids: (rooms.data ?? []).filter((r) => r.phase_id === p.id).map((r) => r.room_id),
    items: (items.data ?? []).filter((i) => i.phase_id === p.id).map(({ id, label, position }) => ({ id, label, position })),
    fields: (fields.data ?? [])
      .filter((f) => f.phase_id === p.id)
      .map((f) => ({
        id: f.id,
        kind: f.kind as 'text' | 'choice',
        label: f.label,
        help: f.help,
        required: f.required,
        max_length: f.max_length,
        position: f.position,
        options: options.filter((o) => o.field_id === f.id).map(({ id, label, body, position }) => ({ id, label, body, position })),
      })),
  }));
}

/** The phase live in a room at `now`, and the next one to start. */
export function currentAndNext(phases: PhaseRecord[], now: number) {
  let current: PhaseRecord | null = null;
  let next: PhaseRecord | null = null;
  for (const phase of phases) {
    const start = new Date(phase.starts_at).getTime();
    const end = new Date(phase.ends_at).getTime();
    if (start <= now && now < end) current = phase;
    else if (start > now && (!next || start < new Date(next.starts_at).getTime())) next = phase;
  }
  return { current, next };
}

/** Turns the database's "PHASE_OVERLAP|<room>|<other phase>" into a sentence. */
export function describePhaseError(message: string): string | null {
  if (message.indexOf('PHASE_OVERLAP|') !== -1) {
    const [, room, other] = message.slice(message.indexOf('PHASE_OVERLAP|')).split('|');
    return 'Room ' + room + ' already has “' + other + '” during that time. Phases in the same room cannot overlap.';
  }
  if (message.indexOf('PHASE_NOT_FOUND') !== -1) return 'That phase no longer exists.';
  if (message.indexOf('PHASE_FIELD_LIMIT') !== -1) return 'A phase can have at most 10 form questions.';
  return null;
}
