import { NextRequest } from 'next/server';
import { audit, requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, HttpError, json, readJson, requireString } from '@/lib/server/http';
import { isUniqueViolation, optionalText, parseCode } from '@/lib/server/validate';

export const dynamic = 'force-dynamic';

/** Rooms with how many displays, teams and operators each has. */
export const GET = handle(async (req: NextRequest) => {
  await requireSession(req, ['admin']);
  const db = getServiceClient();

  const [rooms, displays, teams, operators] = await Promise.all([
    db.from('rooms').select('*').order('code'),
    db.from('event_displays').select('room_id'),
    db.from('teams').select('room_id'),
    db.from('operator_rooms').select('room_id'),
  ]);
  for (const r of [rooms, displays, teams, operators]) if (r.error) throw r.error;

  const tally = (rows: { room_id: string | null }[] | null) => {
    const counts: Record<string, number> = {};
    (rows ?? []).forEach((row) => {
      if (row.room_id) counts[row.room_id] = (counts[row.room_id] ?? 0) + 1;
    });
    return counts;
  };
  const displayCounts = tally(displays.data);
  const teamCounts = tally(teams.data);
  const operatorCounts = tally(operators.data);

  return json({
    rooms: (rooms.data ?? []).map((room) => ({
      ...room,
      display_count: displayCounts[room.id] ?? 0,
      team_count: teamCounts[room.id] ?? 0,
      operator_count: operatorCounts[room.id] ?? 0,
    })),
  });
});

/**
 * Creates one room ({ code, name, location }) or many ({ rooms: [...] }).
 * Bulk creation is all-or-nothing so a half-imported list never lingers.
 */
export const POST = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['admin']);
  const body = await readJson<Record<string, unknown>>(req);

  const input = Array.isArray(body.rooms) ? body.rooms : [body];
  if (input.length === 0 || input.length > 500) throw new HttpError(400, 'Provide between 1 and 500 rooms.');

  const rows = input.map((raw, index) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const prefix = input.length > 1 ? 'Row ' + (index + 1) + ': ' : '';
    try {
      return {
        code: parseCode(item.code, 'Room code', true),
        name: requireString(item.name, 'Room name', 80),
        location: optionalText(item.location, 120),
      };
    } catch (err) {
      if (err instanceof HttpError) throw new HttpError(400, prefix + err.message);
      throw err;
    }
  });

  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.code)) throw new HttpError(400, 'Room code ' + row.code + ' appears twice.');
    seen.add(row.code);
  }

  const { data, error } = await getServiceClient().from('rooms').insert(rows).select('*');
  if (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'One of these room codes already exists.');
    throw error;
  }

  await audit(account.account_id, 'ROOMS_CREATED', rows.length === 1 ? rows[0].code : rows.length + ' rooms', rows.map((r) => r.code).join(', ').slice(0, 500));
  return json({ rooms: data ?? [] });
});
