import 'server-only';
import { getServiceClient } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { cached, invalidate } from '@/lib/server/cache';

export type ParticipantContext = {
  teamId: string;
  teamName: string;
  teamCode: string;
  roomId: string | null;
  roomCode: string | null;
  roomName: string | null;
};

/**
 * Three reads that hardly ever change, on every participant page load. Held
 * briefly so moving a participant between teams shows up within seconds
 * instead of costing 2000 lookups a minute.
 */
const CONTEXT_CACHE_MS = 15000;

export function invalidateParticipantContext(accountUuid: string) {
  invalidate('participant:ctx:' + accountUuid);
}

/** After a team moves room, every one of its members is looking at the old one. */
export function invalidateAllParticipantContexts() {
  invalidate('participant:ctx:');
}

export function loadParticipantContext(accountUuid: string): Promise<ParticipantContext> {
  return cached('participant:ctx:' + accountUuid, CONTEXT_CACHE_MS, () => loadParticipantContextUncached(accountUuid));
}

async function loadParticipantContextUncached(accountUuid: string): Promise<ParticipantContext> {
  const db = getServiceClient();
  const { data: account, error } = await db.from('accounts').select('team_id').eq('id', accountUuid).maybeSingle();
  if (error) throw error;
  if (!account?.team_id) throw new HttpError(403, 'Your account is not assigned to a team. Ask the core team.');

  const { data: team, error: teamError } = await db.from('teams').select('id, name, code, room_id').eq('id', account.team_id).maybeSingle();
  if (teamError) throw teamError;
  if (!team) throw new HttpError(403, 'Your team no longer exists. Ask the core team.');

  let roomCode: string | null = null;
  let roomName: string | null = null;
  if (team.room_id) {
    const { data: room, error: roomError } = await db.from('rooms').select('code, name').eq('id', team.room_id).maybeSingle();
    if (roomError) throw roomError;
    roomCode = room?.code ?? null;
    roomName = room?.name ?? null;
  }

  return { teamId: team.id, teamName: team.name, teamCode: team.code, roomId: team.room_id, roomCode, roomName };
}
