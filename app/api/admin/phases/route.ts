import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson, requireString } from '@/lib/server/http';
import { describePhaseError, invalidatePhases, loadPhases } from '@/lib/server/phases';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

const MAX_FIELDS = 10;
const MAX_OPTIONS = 60;
const MAX_PHASE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Every phase with its rooms, checklist, and per-team progress — which teams
 * in the phase's rooms have ticked how many items.
 */
export const GET = handle(async (req: NextRequest) => {
  await requireSession(req, ['admin']);
  const db = getServiceClient();

  const phases = await loadPhases();
  const [teams, progress] = await Promise.all([
    db.from('teams').select('id, name, code, room_id'),
    db.from('team_checklist_progress').select('team_id, item_id'),
  ]);
  if (teams.error) throw teams.error;
  if (progress.error) throw progress.error;

  const doneByTeam: Record<string, Set<string>> = {};
  (progress.data ?? []).forEach((row) => {
    (doneByTeam[row.team_id] = doneByTeam[row.team_id] || new Set()).add(row.item_id);
  });

  const result = phases.map((phase) => {
    const itemIds = phase.items.map((i) => i.id);
    const phaseTeams = (teams.data ?? [])
      .filter((t) => t.room_id && phase.room_ids.indexOf(t.room_id) !== -1)
      .map((t) => ({
        team_id: t.id,
        name: t.name,
        code: t.code,
        room_id: t.room_id,
        done: itemIds.filter((id) => doneByTeam[t.id] && doneByTeam[t.id].has(id)).length,
      }))
      .sort((a, b) => a.done - b.done || a.name.localeCompare(b.name));
    return { ...phase, team_progress: phaseTeams };
  });

  return json({ phases: result });
});

/** Creates ({ ... }) or updates ({ id, ... }) a phase, atomically with rooms and checklist. */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<Record<string, unknown>>(req);

  const id = body.id ? parseUuid(body.id, 'phase id') : null;
  const title = requireString(body.title, 'Title', 120);
  const requirements = typeof body.requirements === 'string' ? body.requirements.slice(0, 5000) : '';

  const startsAt = new Date(String(body.starts_at ?? ''));
  const endsAt = new Date(String(body.ends_at ?? ''));
  if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime())) throw new HttpError(400, 'Start and end times are required.');
  if (endsAt.getTime() <= startsAt.getTime()) throw new HttpError(400, 'The phase must end after it starts.');
  if (endsAt.getTime() - startsAt.getTime() > MAX_PHASE_MS) throw new HttpError(400, 'A phase can be at most 7 days long.');

  if (!Array.isArray(body.room_ids) || body.room_ids.length === 0) throw new HttpError(400, 'Choose at least one room.');
  const roomIds = Array.from(new Set(body.room_ids.map((r) => parseUuid(r, 'room'))));

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length > 50) throw new HttpError(400, 'At most 50 checklist items per phase.');
  const items = rawItems
    .map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      const label = typeof item.label === 'string' ? item.label.trim() : '';
      const itemId = item.id ? parseUuid(item.id, 'checklist item') : null;
      return { id: itemId, label };
    })
    .filter((item) => item.label);
  items.forEach((item) => {
    if (item.label.length > 200) throw new HttpError(400, 'Checklist items must be at most 200 characters.');
  });

  // ---- form fields ----------------------------------------------------
  const rawFields = Array.isArray(body.fields) ? body.fields : [];
  if (rawFields.length > MAX_FIELDS) throw new HttpError(400, 'At most ' + MAX_FIELDS + ' form questions per phase.');
  const fields = rawFields.map((raw, index) => {
    const field = (raw ?? {}) as Record<string, unknown>;
    const kind = field.kind === 'choice' ? 'choice' : 'text';
    const label = typeof field.label === 'string' ? field.label.trim() : '';
    if (!label) throw new HttpError(400, 'Question ' + (index + 1) + ' needs a label.');
    if (label.length > 200) throw new HttpError(400, 'Question labels must be at most 200 characters.');

    const help = typeof field.help === 'string' ? field.help.slice(0, 2000) : '';
    const maxLength = Math.min(Math.max(Number(field.max_length) || 5000, 1), 20000);

    const rawOptions = Array.isArray(field.options) ? field.options : [];
    if (kind === 'choice' && rawOptions.length === 0) {
      throw new HttpError(400, 'Question ' + (index + 1) + ' is a selector but has no choices.');
    }
    if (rawOptions.length > MAX_OPTIONS) {
      throw new HttpError(400, 'At most ' + MAX_OPTIONS + ' choices per question.');
    }
    const options = rawOptions.map((rawOption, optionIndex) => {
      const option = (rawOption ?? {}) as Record<string, unknown>;
      const optionLabel = typeof option.label === 'string' ? option.label.trim() : '';
      if (!optionLabel) throw new HttpError(400, 'Choice ' + (optionIndex + 1) + ' of question ' + (index + 1) + ' needs a title.');
      if (optionLabel.length > 200) throw new HttpError(400, 'Choice titles must be at most 200 characters.');
      return {
        id: option.id ? parseUuid(option.id, 'choice') : null,
        label: optionLabel,
        // The full problem statement. Long on purpose.
        body: typeof option.body === 'string' ? option.body.slice(0, 20000) : '',
      };
    });

    return {
      id: field.id ? parseUuid(field.id, 'question') : null,
      kind,
      label,
      help,
      required: field.required === true,
      max_length: maxLength,
      options: kind === 'choice' ? options : [],
    };
  });

  const { data, error } = await getServiceClient().rpc('save_phase', {
    p_id: id,
    p_title: title,
    p_requirements: requirements,
    p_starts_at: startsAt.toISOString(),
    p_ends_at: endsAt.toISOString(),
    p_room_ids: roomIds,
    p_items: items,
    p_fields: fields,
    p_actor: account.account_id,
  });
  if (error) {
    const friendly = describePhaseError(error.message);
    if (friendly) throw new HttpError(friendly.indexOf('no longer exists') !== -1 ? 404 : 409, friendly);
    if (error.code === '23503') throw new HttpError(400, 'One of the selected rooms no longer exists.');
    throw error;
  }

  invalidatePhases();
  await audit(
    account.account_id,
    id ? 'PHASE_UPDATED' : 'PHASE_CREATED',
    title,
    roomIds.length + ' room(s), ' + items.length + ' checklist item(s), ' + fields.length + ' form question(s)'
  );
  return json({ id: data });
});
