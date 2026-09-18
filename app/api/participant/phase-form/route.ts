import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { loadParticipantContext } from '@/lib/server/participant';
import { currentAndNext, loadPhases, phaseIsOpen } from '@/lib/server/phases';
import { parseUuid } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

/**
 * Saves a team's answers for the phase running in their room.
 *
 * Saving is manual — the page sends the whole form in one request when someone
 * presses Save (and once more on its own if the phase is about to end, so
 * nothing typed is lost at lock time). One request per save, per team, rather
 * than one per keystroke per person: with 2000 participants on one laptop the
 * difference is the event running or not.
 *
 * Answers are shared by the whole team: whoever saves last wins, and the page
 * shows who that was.
 */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['participant']);
  const ctx = await loadParticipantContext(account.id);
  if (!ctx.roomId) throw new HttpError(403, 'Your team has no room, so there is no phase to answer.');

  const body = await readJson<{ phase_id?: unknown; answers?: unknown }>(req);
  const phaseId = parseUuid(body.phase_id, 'phase');

  const now = Date.now();
  const phases = await loadPhases({ roomId: ctx.roomId });
  const { current } = currentAndNext(phases, now);

  if (!current || current.id !== phaseId) {
    throw new HttpError(409, 'That phase is no longer running in your room. Copy your answers somewhere safe before reloading.');
  }
  if (!phaseIsOpen(current, now)) {
    throw new HttpError(409, 'This phase has ended, so answers are locked.');
  }
  if (current.fields.length === 0) throw new HttpError(400, 'This phase has no form.');

  const submitted = Array.isArray(body.answers) ? body.answers : [];
  const byFieldId = new Map<string, { value: unknown; option_id: unknown }>();
  submitted.forEach((raw) => {
    const answer = (raw ?? {}) as Record<string, unknown>;
    if (typeof answer.field_id !== 'string') return;
    byFieldId.set(answer.field_id, { value: answer.value, option_id: answer.option_id });
  });

  const rows: {
    team_id: string;
    field_id: string;
    value: string;
    option_id: string | null;
    answered_by: string;
    updated_at: string;
  }[] = [];

  for (const field of current.fields) {
    const answer = byFieldId.get(field.id);
    // A field the page didn't send is left exactly as it is, so a stale tab
    // can't blank out an answer someone else just saved.
    if (!answer) continue;

    let value = '';
    let optionId: string | null = null;

    if (field.kind === 'choice') {
      if (answer.option_id) {
        const chosen = parseUuid(answer.option_id, 'choice');
        const known = field.options.find((o) => o.id === chosen);
        if (!known) throw new HttpError(400, 'That choice is no longer offered for “' + field.label + '”.');
        optionId = known.id;
        // The label is copied in so the export still reads correctly if the
        // option is later renamed or removed.
        value = known.label;
      }
    } else {
      value = typeof answer.value === 'string' ? answer.value : '';
      if (value.length > field.max_length) {
        throw new HttpError(400, '“' + field.label + '” is longer than the ' + field.max_length + ' characters allowed.');
      }
    }

    rows.push({
      team_id: ctx.teamId,
      field_id: field.id,
      value,
      option_id: optionId,
      answered_by: account.account_id,
      updated_at: new Date().toISOString(),
    });
  }

  if (rows.length === 0) throw new HttpError(400, 'Nothing to save.');

  const { error } = await getServiceClient().from('team_phase_answers').upsert(rows, { onConflict: 'team_id,field_id' });
  if (error) throw error;

  // Deliberately not written to the audit log: 400 teams saving repeatedly
  // would bury every other entry.
  return json({ ok: true, saved_at: new Date().toISOString(), saved_by: account.account_id, fields: rows.length });
});
