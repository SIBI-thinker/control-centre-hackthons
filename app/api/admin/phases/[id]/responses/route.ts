import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { fileResponse, handle, HttpError } from '@/lib/server/http';
import { loadPhases } from '@/lib/server/phases';
import { parseUuid } from '@/lib/server/validate';
import { toCsv } from '@/lib/csv';
import { brandSlug } from '@/lib/brand';
import { loadEventState } from '@/lib/server/event';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/**
 * One phase's answers as a CSV, one row per team, optionally narrowed to a
 * single venue.
 *
 * Built on the server and streamed back as a file: the answers are long
 * paragraphs, and 400 teams' worth has no business being loaded into the
 * console just to be turned into a download.
 */
export const GET = handle<Ctx>(async (req: NextRequest, { params }) => {
  const { account } = await requireSession(req, ['admin']);
  const phaseId = parseUuid(params.id, 'phase id');

  const roomParam = req.nextUrl.searchParams.get('room_id');
  const roomId = roomParam ? parseUuid(roomParam, 'room id') : null;

  const [phase] = await loadPhases({ phaseIds: [phaseId] });
  if (!phase) throw new HttpError(404, 'That phase no longer exists.');
  if (roomId && phase.room_ids.indexOf(roomId) === -1) {
    throw new HttpError(400, 'That venue is not part of this phase.');
  }

  const db = getServiceClient();

  // The teams this export covers: those sitting in the phase's rooms.
  const roomIds = roomId ? [roomId] : phase.room_ids;
  const { data: teams, error: teamsError } =
    roomIds.length > 0
      ? await db.from('teams').select('id, code, name, room_id').in('room_id', roomIds).order('code')
      : { data: [], error: null };
  if (teamsError) throw teamsError;

  const { data: rooms, error: roomsError } = await db.from('rooms').select('id, code, name').in('id', roomIds.length ? roomIds : ['']);
  if (roomsError) throw roomsError;
  const roomById = new Map((rooms ?? []).map((r) => [r.id, r]));

  const fieldIds = phase.fields.map((f) => f.id);
  const answers = new Map<string, { value: string; answered_by: string | null; updated_at: string }>();
  if (fieldIds.length > 0 && (teams ?? []).length > 0) {
    const teamIds = (teams ?? []).map((t) => t.id);
    // Chunked so a large event doesn't build a URL longer than PostgREST accepts.
    for (let i = 0; i < teamIds.length; i += 200) {
      const { data, error } = await db
        .from('team_phase_answers')
        .select('team_id, field_id, value, answered_by, updated_at')
        .in('field_id', fieldIds)
        .in('team_id', teamIds.slice(i, i + 200));
      if (error) throw error;
      (data ?? []).forEach((row) => {
        answers.set(row.team_id + '|' + row.field_id, {
          value: row.value,
          answered_by: row.answered_by,
          updated_at: row.updated_at,
        });
      });
    }
  }

  const header = ['team_code', 'team_name', 'venue_code', 'venue_name']
    .concat(phase.fields.map((f) => f.label))
    .concat(['last_saved_by', 'last_saved_at']);

  const rows = [header].concat(
    (teams ?? []).map((team) => {
      const room = team.room_id ? roomById.get(team.room_id) : null;
      let lastBy = '';
      let lastAt = '';
      const cells = phase.fields.map((field) => {
        const answer = answers.get(team.id + '|' + field.id);
        if (answer && answer.updated_at > lastAt) {
          lastAt = answer.updated_at;
          lastBy = answer.answered_by ?? '';
        }
        return answer ? answer.value : '';
      });
      return [team.code, team.name, room?.code ?? '', room?.name ?? '']
        .concat(cells)
        .concat([lastBy, lastAt ? new Date(lastAt).toLocaleString('en-IN') : '']);
    })
  );

  const state = await loadEventState().catch(() => null);
  const venueLabel = roomId ? roomById.get(roomId)?.code ?? 'venue' : 'all-venues';
  const filename =
    brandSlug(state?.event_name) + '-' + brandSlug(phase.title) + '-' + brandSlug(venueLabel) + '.csv';

  await audit(account.account_id, 'PHASE_RESPONSES_EXPORTED', phase.title, (teams ?? []).length + ' team(s), ' + venueLabel);

  // A BOM so Excel opens the long answers as UTF-8.
  return fileResponse('﻿' + toCsv(rows), 'text/csv; charset=utf-8', filename);
});
