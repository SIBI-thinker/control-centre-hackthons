import 'server-only';
import { getServiceClient } from '@/lib/server/db';
import { cached, invalidate } from '@/lib/server/cache';

export type WifiSettings = {
  ssid: string | null;
  /** The network passphrase, shared by everyone. */
  ssid_password: string | null;
  instructions: string | null;
  default_username: string | null;
  default_password: string | null;
};

export type ResolvedWifi = {
  ssid: string | null;
  ssid_password: string | null;
  instructions: string | null;
  username: string | null;
  password: string | null;
  /** Where the login came from, so the UI can explain it. */
  source: 'personal' | 'team' | 'default' | null;
};

/** The same row for everyone, read on every participant page load. */
const WIFI_SETTINGS_CACHE_MS = 15000;

export function invalidateWifiSettings() {
  invalidate('wifi:settings');
}

export function loadWifiSettings(): Promise<WifiSettings> {
  return cached('wifi:settings', WIFI_SETTINGS_CACHE_MS, loadWifiSettingsUncached);
}

async function loadWifiSettingsUncached(): Promise<WifiSettings> {
  const { data, error } = await getServiceClient()
    .from('wifi_settings')
    .select('ssid, ssid_password, instructions, default_username, default_password')
    .eq('id', true)
    .maybeSingle();
  if (error) throw error;
  return data ?? { ssid: null, ssid_password: null, instructions: null, default_username: null, default_password: null };
}

/**
 * The login one participant should see: their own, else their team's, else the
 * event-wide default.
 */
export async function resolveWifiFor(accountUuid: string, teamId: string | null): Promise<ResolvedWifi> {
  const db = getServiceClient();
  const settings = await loadWifiSettings();
  const base = { ssid: settings.ssid, ssid_password: settings.ssid_password, instructions: settings.instructions };

  const { data: personal, error } = await db
    .from('wifi_credentials')
    .select('username, password')
    .eq('assigned_account_id', accountUuid)
    .maybeSingle();
  if (error) throw error;
  if (personal) return { ...base, username: personal.username, password: personal.password, source: 'personal' };

  if (teamId) {
    const { data: team, error: teamError } = await db
      .from('wifi_credentials')
      .select('username, password')
      .eq('assigned_team_id', teamId)
      .maybeSingle();
    if (teamError) throw teamError;
    if (team) return { ...base, username: team.username, password: team.password, source: 'team' };
  }

  if (settings.default_username && settings.default_password) {
    return { ...base, username: settings.default_username, password: settings.default_password, source: 'default' };
  }

  return { ...base, username: null, password: null, source: null };
}

/** Team logins for a set of rooms — what a room operator is allowed to see. */
export async function teamWifiForRooms(roomIds: string[]) {
  if (roomIds.length === 0) return [];
  const db = getServiceClient();
  const { data: teams, error } = await db.from('teams').select('id, name, code, room_id').in('room_id', roomIds);
  if (error) throw error;
  if (!teams || teams.length === 0) return [];

  const { data: credentials, error: credentialsError } = await db
    .from('wifi_credentials')
    .select('assigned_team_id, username, password')
    .in('assigned_team_id', teams.map((t) => t.id));
  if (credentialsError) throw credentialsError;

  const byTeam = new Map<string, { username: string; password: string }>();
  (credentials ?? []).forEach((c) => {
    if (c.assigned_team_id) byTeam.set(c.assigned_team_id, { username: c.username, password: c.password });
  });

  return teams.map((t) => ({
    team_id: t.id,
    team_name: t.name,
    team_code: t.code,
    room_id: t.room_id,
    username: byTeam.get(t.id)?.username ?? null,
    password: byTeam.get(t.id)?.password ?? null,
  }));
}
