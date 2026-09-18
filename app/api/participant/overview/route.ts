import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, json } from '@/lib/server/http';
import { loadParticipantContext } from '@/lib/server/participant';
import { currentAndNext, loadPhases, phaseIsOpen } from '@/lib/server/phases';
import { resolveWifiFor } from '@/lib/server/wifi';

export const dynamic = 'force-dynamic';

/**
 * Everything the participant page shows: team, room, teammates, the phase
 * running in their room right now (with the team's checklist ticks), and the
 * next phase coming up.
 */
export const GET = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['participant']);
  const ctx = await loadParticipantContext(account.id);
  const db = getServiceClient();
  const now = Date.now();

  const wifi = await resolveWifiFor(account.id, ctx.teamId);

  const { data: teammates, error: teammatesError } = await db
    .from('accounts')
    .select('account_id, display_name')
    .eq('team_id', ctx.teamId)
    .eq('active', true)
    .order('display_name');
  if (teammatesError) throw teammatesError;

  let current = null;
  let next = null;
  if (ctx.roomId) {
    const phases = await loadPhases({ roomId: ctx.roomId });
    const picked = currentAndNext(phases, now);

    if (picked.current) {
      const itemIds = picked.current.items.map((i) => i.id);
      const ticks: Record<string, { checked_by: string | null; checked_at: string }> = {};
      if (itemIds.length > 0) {
        const { data, error } = await db
          .from('team_checklist_progress')
          .select('item_id, checked_by, checked_at')
          .eq('team_id', ctx.teamId)
          .in('item_id', itemIds);
        if (error) throw error;
        (data ?? []).forEach((row) => (ticks[row.item_id] = { checked_by: row.checked_by, checked_at: row.checked_at }));
      }
      // The team's saved answers for this phase's questions.
      const fieldIds = picked.current.fields.map((f) => f.id);
      const answers: Record<string, { value: string; option_id: string | null; answered_by: string | null; updated_at: string }> = {};
      if (fieldIds.length > 0) {
        const { data, error } = await db
          .from('team_phase_answers')
          .select('field_id, value, option_id, answered_by, updated_at')
          .eq('team_id', ctx.teamId)
          .in('field_id', fieldIds);
        if (error) throw error;
        (data ?? []).forEach((row) => {
          answers[row.field_id] = {
            value: row.value,
            option_id: row.option_id,
            answered_by: row.answered_by,
            updated_at: row.updated_at,
          };
        });
      }

      current = {
        id: picked.current.id,
        title: picked.current.title,
        requirements: picked.current.requirements,
        starts_at: picked.current.starts_at,
        ends_at: picked.current.ends_at,
        // Answers are frozen when the phase's window closes.
        form_open: phaseIsOpen(picked.current, now),
        fields: picked.current.fields.map((field) => ({
          id: field.id,
          kind: field.kind,
          label: field.label,
          help: field.help,
          required: field.required,
          max_length: field.max_length,
          options: field.options.map((o) => ({ id: o.id, label: o.label, body: o.body })),
          value: answers[field.id]?.value ?? '',
          option_id: answers[field.id]?.option_id ?? null,
          answered_by: answers[field.id]?.answered_by ?? null,
          updated_at: answers[field.id]?.updated_at ?? null,
        })),
        items: picked.current.items.map((item) => ({
          id: item.id,
          label: item.label,
          checked: Boolean(ticks[item.id]),
          checked_by: ticks[item.id]?.checked_by ?? null,
          checked_at: ticks[item.id]?.checked_at ?? null,
        })),
      };
    }

    // Only the name and start time of the next phase — its requirements stay
    // hidden until it begins.
    if (picked.next) {
      next = { id: picked.next.id, title: picked.next.title, starts_at: picked.next.starts_at, ends_at: picked.next.ends_at };
    }
  }

  return json({
    serverNow: now,
    me: { accountId: account.account_id, name: account.display_name },
    team: { id: ctx.teamId, name: ctx.teamName, code: ctx.teamCode },
    room: ctx.roomId ? { id: ctx.roomId, code: ctx.roomCode, name: ctx.roomName } : null,
    teammates: teammates ?? [],
    wifi,
    currentPhase: current,
    nextPhase: next,
  });
});
