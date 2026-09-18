import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson } from '@/lib/server/http';
import { ACCOUNT_ID_PATTERN, ID_PREFIX, issuePins, nextSequentialIds } from '@/lib/server/people';
import { csvToRecords } from '@/lib/csv';
import { buildTeamIndex, newTeamKey, reconcileNewTeamRooms, resolveImportTeam, type TeamRef } from '@/lib/server/teams';
import type { IssuedCredential } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const MAX_ROWS = 1000;

type PreviewRow = {
  line: number;
  account_id: string | null;
  name: string;
  team?: string;
  team_id?: string;
  room?: string;
  rooms?: string[];
  new_team?: boolean;
  error?: string;
};

/**
 * CSV import of participants or operators.
 *
 *   { kind, csv, commit: false }  → validates every row, creates nothing
 *   { kind, csv, commit: true }   → creates everything, only if no row fails
 *
 * Participants CSV:  name, team, room (room code), id (optional),
 *                     team_id (optional — a team code, which pins the row to
 *                     one exact team even when names repeat)
 * Operators CSV:     name, rooms (codes separated by | or ;), id (optional)
 *
 * Missing IDs are generated. PINs are always generated and returned once.
 */
export const POST = handle(async (req: NextRequest) => {
  const { account: actor } = await requireSession(req, ['admin']);
  const body = await readJson<{ kind: string; csv: string; commit: boolean }>(req);

  if (body.kind !== 'participants' && body.kind !== 'operators') throw new HttpError(400, 'Choose participants or operators.');
  if (typeof body.csv !== 'string' || !body.csv.trim()) throw new HttpError(400, 'The CSV is empty.');
  if (body.csv.length > 500_000) throw new HttpError(400, 'The CSV is too large.');

  const required = body.kind === 'participants' ? ['name'] : ['name', 'rooms'];
  const { records, missing, headers } = csvToRecords(body.csv, required);
  if (missing.length > 0) throw new HttpError(400, 'Missing column(s): ' + missing.join(', ') + '. The first row must be a header.');
  // A participant has to land in a team, named either way round.
  if (body.kind === 'participants' && headers.indexOf('team') === -1 && headers.indexOf('team_id') === -1) {
    throw new HttpError(400, 'Missing column: team (or team_id). The first row must be a header.');
  }
  if (records.length === 0) throw new HttpError(400, 'The CSV has a header but no rows.');
  if (records.length > MAX_ROWS) throw new HttpError(400, 'At most ' + MAX_ROWS + ' rows per import.');

  const db = getServiceClient();
  const { data: rooms, error: roomsError } = await db.from('rooms').select('id, code, name');
  if (roomsError) throw roomsError;
  const roomByCode = new Map<string, { id: string; code: string; name: string }>();
  (rooms ?? []).forEach((r) => roomByCode.set(r.code.toUpperCase(), r));

  // IDs supplied in the file: must be well-formed, unique in the file, unused.
  const suppliedIds = records.map((r) => (r.id || '').trim().toUpperCase()).filter(Boolean);
  const takenInDb = new Set<string>();
  for (let i = 0; i < suppliedIds.length; i += 200) {
    const { data, error } = await db.from('accounts').select('account_id').in('account_id', suppliedIds.slice(i, i + 200));
    if (error) throw error;
    (data ?? []).forEach((row) => takenInDb.add(row.account_id));
  }
  const seenIds = new Set<string>();

  const preview: PreviewRow[] = [];

  const checkId = (raw: string): { id: string | null; error?: string } => {
    const id = raw.trim().toUpperCase();
    if (!id) return { id: null };
    if (!ACCOUNT_ID_PATTERN.test(id)) return { id, error: 'ID must be 2–40 letters, numbers, dot, dash or underscore' };
    if (seenIds.has(id)) return { id, error: 'ID appears more than once in this file' };
    seenIds.add(id);
    if (takenInDb.has(id)) return { id, error: 'ID is already in use' };
    return { id };
  };

  // ------------------------------------------------------------ participants
  if (body.kind === 'participants') {
    const { data: teams, error: teamsError } = await db.from('teams').select('id, code, name, room_id');
    if (teamsError) throw teamsError;
    const teamIndex = buildTeamIndex((teams ?? []) as TeamRef[]);

    // New teams this file creates, grouped by name AND room: two rooms with a
    // "Hack Horizon" each are two separate teams.
    const newTeamRoom = new Map<string, { name: string; roomCode: string }>();

    // Which team each row landed on, decided once here so the commit below
    // never has to look a name up again — with duplicate names allowed, a
    // second lookup could resolve to a different team.
    const resolutions: ({ kind: 'existing'; id: string } | { kind: 'new'; key: string } | null)[] = [];

    records.forEach((record, index) => {
      const line = index + 2;
      const name = record.name;
      const teamName = record.team;
      const teamCode = (record.team_id || record.team_code || '').trim();
      const roomCode = (record.room || '').trim().toUpperCase();
      const idCheck = checkId(record.id || '');
      const row: PreviewRow = { line, account_id: idCheck.id, name, team: teamName, team_id: teamCode || undefined, room: roomCode || undefined };

      const fail = (message: string) => {
        if (!row.error) row.error = message;
      };

      if (idCheck.error) fail(idCheck.error);
      if (!name) fail('Name is required');
      else if (name.length > 120) fail('Name is longer than 120 characters');
      if (!teamName && !teamCode) fail('Team is required — give a team name or a team id');
      if (teamName && teamName.length > 80) fail('Team name is longer than 80 characters');

      if (roomCode && !roomByCode.has(roomCode)) fail('Room ' + roomCode + ' does not exist — create it in Rooms first');

      let resolution: { kind: 'existing'; id: string } | { kind: 'new'; key: string } | null = null;
      if (teamName || teamCode) {
        const outcome = resolveImportTeam({
          index: teamIndex,
          teamName: teamName || '',
          teamCode,
          roomId: roomCode && roomByCode.has(roomCode) ? roomByCode.get(roomCode)!.id : null,
        });
        if (outcome.kind === 'error') {
          fail(outcome.message);
        } else if (outcome.kind === 'existing') {
          row.team = outcome.team.name;
          resolution = { kind: 'existing', id: outcome.team.id };
        } else {
          row.new_team = true;
          const key = newTeamKey(outcome.name, roomCode);
          if (!newTeamRoom.has(key)) newTeamRoom.set(key, { name: outcome.name, roomCode });
          resolution = { kind: 'new', key };
        }
      }

      resolutions.push(resolution);
      preview.push(row);
    });

    const reconciled = reconcileNewTeamRooms(
      resolutions.map((r) => (r && r.kind === 'new' ? r.key : null)),
      newTeamRoom
    );
    reconciled.keys.forEach((key, index) => {
      if (key) resolutions[index] = { kind: 'new', key };
      if (reconciled.errors[index] && !preview[index].error) preview[index].error = reconciled.errors[index]!;
    });

    // Keep only the groups rows actually ended up in.
    const usedKeys = new Set(resolutions.filter((r) => r && r.kind === 'new').map((r) => (r as { key: string }).key));
    Array.from(newTeamRoom.keys()).forEach((key) => {
      if (!usedKeys.has(key)) newTeamRoom.delete(key);
    });

    const errors = preview.filter((r) => r.error).length;
    const summary = {
      rows: preview.length,
      errors,
      new_teams: Array.from(newTeamRoom.values()).map((t) => t.name + (t.roomCode ? ' (' + t.roomCode + ')' : '')),
      generated_ids: preview.filter((r) => !r.account_id).length,
    };

    if (!body.commit || errors > 0) {
      return json({ preview, summary, committed: false });
    }

    // Create new teams.
    const newTeamKeys = Array.from(newTeamRoom.keys());
    const newTeams = newTeamKeys.map((key) => newTeamRoom.get(key)!);
    const teamCodes = await nextSequentialIds('teams', 'code', 'T-', newTeams.length, 3);
    let createdTeamIds: string[] = [];
    // Keyed by the file's team name, not looked up by name afterwards.
    const createdByKey = new Map<string, TeamRef>();
    if (newTeams.length > 0) {
      const { data: inserted, error } = await db
        .from('teams')
        .insert(newTeams.map((t, i) => ({ code: teamCodes[i], name: t.name, room_id: t.roomCode ? roomByCode.get(t.roomCode)!.id : null })))
        .select('id, code, name, room_id');
      if (error) {
        if (error.code === '23505') {
          // Until the duplicate-names migration is applied the database still
          // refuses a second team with an existing name, and the message needs
          // to say so rather than blaming a code clash.
          const detail = ((error.message || '') + ' ' + ((error as { details?: string }).details || '')).toLowerCase();
          if (detail.indexOf('teams_name_key') !== -1) {
            throw new HttpError(409, 'The database still requires unique team names. Apply the 20260918140000_allow_duplicate_team_names migration, then import again.');
          }
          throw new HttpError(409, 'A team code was taken by someone else meanwhile. Preview again.');
        }
        throw error;
      }
      createdTeamIds = (inserted ?? []).map((t) => t.id);
      // Matched on the code this import generated for each one, rather than on
      // the returned row order, which nothing guarantees.
      const insertedByCode = new Map<string, TeamRef>();
      (inserted ?? []).forEach((t) => insertedByCode.set(t.code, t as TeamRef));
      for (let i = 0; i < newTeamKeys.length; i++) {
        const created = insertedByCode.get(teamCodes[i]);
        if (!created) {
          // Don't leave half-made teams behind for an import that never ran.
          await db.from('teams').delete().in('id', createdTeamIds);
          throw new HttpError(500, 'A team could not be created. Nothing was imported.');
        }
        createdByKey.set(newTeamKeys[i], created);
      }
    }

    const teamById = new Map<string, TeamRef>();
    ((teams ?? []) as TeamRef[]).forEach((t) => teamById.set(t.id, t));
    createdByKey.forEach((t) => teamById.set(t.id, t));

    const autoIds = await nextSequentialIds(
      'accounts',
      'account_id',
      ID_PREFIX.participant.prefix,
      preview.filter((r) => !r.account_id).length,
      ID_PREFIX.participant.pad,
      seenIds
    );
    let autoIndex = 0;
    const pins = await issuePins(preview.length);

    const roomLabelById = new Map<string, string>();
    (rooms ?? []).forEach((r) => roomLabelById.set(r.id, r.code + ' · ' + r.name));

    const credentials: IssuedCredential[] = [];
    const rows = preview.map((row, i) => {
      const accountId = row.account_id || autoIds[autoIndex++];
      const resolution = resolutions[i]!;
      const team = resolution.kind === 'existing' ? teamById.get(resolution.id)! : createdByKey.get(resolution.key)!;
      credentials.push({
        account_id: accountId,
        display_name: row.name,
        role: 'participant',
        pin: pins[i].pin,
        team_name: team.name,
        room_label: team.room_id ? roomLabelById.get(team.room_id) ?? null : null,
      });
      return { account_id: accountId, role: 'participant', display_name: row.name, pin_hash: pins[i].hash, team_id: team.id };
    });

    // One statement: either every participant is created or none are.
    const { error: insertError } = await db.from('accounts').insert(rows);
    if (insertError) {
      if (createdTeamIds.length > 0) await db.from('teams').delete().in('id', createdTeamIds);
      if (insertError.code === '23505') throw new HttpError(409, 'An ID was taken by someone else meanwhile. Preview again.');
      throw insertError;
    }

    await audit(actor.account_id, 'PARTICIPANTS_IMPORTED', rows.length + ' participants', newTeams.length + ' new team(s)');
    return json({ preview, summary, committed: true, credentials });
  }

  // --------------------------------------------------------------- operators
  records.forEach((record, index) => {
    const line = index + 2;
    const idCheck = checkId(record.id || '');
    const codes = (record.rooms || '')
      .split(/[|;]/)
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    const row: PreviewRow = { line, account_id: idCheck.id, name: record.name, rooms: codes };
    const fail = (message: string) => {
      if (!row.error) row.error = message;
    };

    if (idCheck.error) fail(idCheck.error);
    if (!record.name) fail('Name is required');
    else if (record.name.length > 120) fail('Name is longer than 120 characters');
    if (codes.length === 0) fail('At least one room is required');
    const unknown = codes.filter((c) => !roomByCode.has(c));
    if (unknown.length > 0) fail('Unknown room(s): ' + unknown.join(', '));

    preview.push(row);
  });

  const errors = preview.filter((r) => r.error).length;
  const summary = { rows: preview.length, errors, generated_ids: preview.filter((r) => !r.account_id).length };

  if (!body.commit || errors > 0) {
    return json({ preview, summary, committed: false });
  }

  const autoIds = await nextSequentialIds('accounts', 'account_id', ID_PREFIX.operator.prefix, summary.generated_ids, ID_PREFIX.operator.pad, seenIds);
  let autoIndex = 0;
  const pins = await issuePins(preview.length);

  const credentials: IssuedCredential[] = [];
  const accountRows = preview.map((row, i) => {
    const accountId = row.account_id || autoIds[autoIndex++];
    credentials.push({
      account_id: accountId,
      display_name: row.name,
      role: 'operator',
      pin: pins[i].pin,
      room_label: (row.rooms ?? []).join(', '),
    });
    return { account_id: accountId, role: 'operator', display_name: row.name, pin_hash: pins[i].hash };
  });

  const { data: created, error: insertError } = await db.from('accounts').insert(accountRows).select('id, account_id');
  if (insertError) {
    if (insertError.code === '23505') throw new HttpError(409, 'An ID was taken by someone else meanwhile. Preview again.');
    throw insertError;
  }

  const idByAccountId = new Map<string, string>();
  (created ?? []).forEach((c) => idByAccountId.set(c.account_id, c.id));
  const links: { account_id: string; room_id: string }[] = [];
  preview.forEach((row, i) => {
    const uuid = idByAccountId.get(credentials[i].account_id)!;
    (row.rooms ?? []).forEach((code) => links.push({ account_id: uuid, room_id: roomByCode.get(code)!.id }));
  });

  const { error: linkError } = await db.from('operator_rooms').upsert(links, { ignoreDuplicates: true });
  if (linkError) {
    // Operators without rooms are useless — undo the whole import.
    await db.from('accounts').delete().in('id', Array.from(idByAccountId.values()));
    throw linkError;
  }

  await audit(actor.account_id, 'OPERATORS_IMPORTED', accountRows.length + ' operators', null);
  return json({ preview, summary, committed: true, credentials });
});
