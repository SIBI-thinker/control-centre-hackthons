import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/server/auth';
import { getServiceClient } from '@/lib/server/db';
import { handle, json } from '@/lib/server/http';
import { loadOperatorRooms } from '@/lib/server/operator';
import { currentAndNext, loadPhases } from '@/lib/server/phases';
import { teamWifiForRooms } from '@/lib/server/wifi';

export const dynamic = 'force-dynamic';

const ONLINE_WINDOW_MS = 35000;

/**
 * An operator's rooms, each with its displays (online or not), teams, and the
 * phase running there now. Nothing outside their assigned rooms is returned.
 */
export const GET = handle(async (req: NextRequest) => {
  const { account } = await requireSession(req, ['operator']);
  const rooms = await loadOperatorRooms(account.id);
  const now = Date.now();

  if (rooms.length === 0) return json({ serverNow: now, rooms: [] });

  const db = getServiceClient();
  const roomIds = rooms.map((r) => r.id);
  const [displays, teams, phases, wifi] = await Promise.all([
    db.from('event_displays').select('id, display_id, display_name, enabled, last_heartbeat_at, room_id').in('room_id', roomIds),
    db.from('teams').select('id, name, code, room_id').in('room_id', roomIds).order('name'),
    loadPhases(),
    teamWifiForRooms(roomIds),
  ]);
  if (displays.error) throw displays.error;
  if (teams.error) throw teams.error;

  return json({
    serverNow: now,
    rooms: rooms.map((room) => {
      const roomPhases = phases.filter((p) => p.room_ids.indexOf(room.id) !== -1);
      const { current, next } = currentAndNext(roomPhases, now);
      return {
        ...room,
        displays: (displays.data ?? [])
          .filter((d) => d.room_id === room.id)
          .map((d) => ({
            id: d.id,
            display_id: d.display_id,
            display_name: d.display_name,
            enabled: d.enabled,
            online: Boolean(d.enabled && d.last_heartbeat_at && now - new Date(d.last_heartbeat_at).getTime() < ONLINE_WINDOW_MS),
          })),
        teams: (teams.data ?? []).filter((t) => t.room_id === room.id).map((t) => {
          const login = wifi.find((w) => w.team_id === t.id);
          return { id: t.id, name: t.name, code: t.code, wifi_username: login ? login.username : null, wifi_password: login ? login.password : null };
        }),
        current_phase: current ? { title: current.title, starts_at: current.starts_at, ends_at: current.ends_at } : null,
        next_phase: next ? { title: next.title, starts_at: next.starts_at } : null,
      };
    }),
  });
});
